#!/usr/bin/env python3
"""Keep the fixed local campaign-control API process available."""

from __future__ import annotations

import argparse
import fcntl
import http.client
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

HOST = "127.0.0.1"
PORT = 4391
POLL_SECONDS = 10
RESTART_BASE_SECONDS = 5
RESTART_MAX_SECONDS = 300
_STOP_EVENT = threading.Event()


class SupervisorError(RuntimeError):
	pass


@dataclass(frozen=True)
class Listener:
	host: str
	port: int
	pid: int
	argv: tuple[str, ...]
	cwd: str


def parse_ss_row(row: str) -> tuple[str, int, int] | None:
	fields = row.split()
	if len(fields) < 5 or fields[0] != "LISTEN":
		return None
	local = fields[3]
	match = re.fullmatch(r"(.+):(\d+)", local)
	pid_match = re.search(r"\bpid=(\d+)\b", row)
	if not match or not pid_match:
		return None
	return match.group(1), int(match.group(2)), int(pid_match.group(1))


def process_details(pid: int, proc_root: Path = Path("/proc")) -> tuple[tuple[str, ...], str] | None:
	try:
		process = proc_root / str(pid)
		status = (process / "stat").read_text(encoding="ascii")
		closing = status.rfind(")")
		fields = status[closing + 1:].strip().split()
		if not fields or fields[0] == "Z":
			return None
		argv = tuple(part.decode("utf-8", "strict") for part in (process / "cmdline").read_bytes().split(b"\0") if part)
		if not argv:
			return None
		cwd = os.path.realpath(process / "cwd")
		return argv, cwd
	except (OSError, UnicodeError):
		return None


def listener_matches_campaign(listener: Listener, repo: Path, port: int = PORT) -> bool:
	try:
		repo = repo.resolve(strict=True)
	except OSError:
		return False
	entrypoint = str(repo / "src/cli.ts")
	return (listener.host == HOST and listener.port == port and listener.pid > 1 and
		listener.cwd == str(repo) and listener.argv[-2:] == ("campaign", "serve") and
		entrypoint in listener.argv)


def discover_listener(
	repo: Path,
	port: int = PORT,
	*,
	command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
	proc_root: Path = Path("/proc"),
) -> Listener | None:
	try:
		result = command(["/usr/bin/ss", "-Hlnpt", f"sport = :{port}"], capture_output=True, text=True, check=False)
	except OSError as error:
		raise SupervisorError("cannot inspect the local API listener") from error
	if result.returncode != 0:
		raise SupervisorError("cannot inspect the local API listener")
	lines = [row for row in result.stdout.splitlines() if row.strip()]
	if not lines:
		return None
	rows = [parse_ss_row(row) for row in lines]
	if any(row is None for row in rows):
		raise SupervisorError("port 4391 listener identity is unavailable; leaving it untouched")
	if len(rows) != 1:
		raise SupervisorError("port 4391 has an ambiguous listener; leaving it untouched")
	host, actual_port, pid = rows[0]
	details = process_details(pid, proc_root)
	if details is None:
		raise SupervisorError("port 4391 listener identity is unavailable; leaving it untouched")
	argv, cwd = details
	listener = Listener(host, actual_port, pid, argv, cwd)
	if not listener_matches_campaign(listener, repo, port):
		raise SupervisorError("port 4391 belongs to an unrecognized listener; leaving it untouched")
	return listener


def api_is_healthy(port: int = PORT, *, connection_factory: Callable = http.client.HTTPConnection) -> bool:
	connection = connection_factory("127.0.0.1", port, timeout=3)
	try:
		connection.request("GET", "/api/campaign-control", headers={"Connection": "close"})
		response = connection.getresponse()
		return response.status in (200, 401)
	except (OSError, TimeoutError, http.client.HTTPException):
		return False
	finally:
		connection.close()


def restart_delay(failures: int) -> int:
	if failures < 1:
		return 0
	return min(RESTART_BASE_SECONDS * (2 ** (failures - 1)), RESTART_MAX_SECONDS)


def acquire_instance_lock(lock_path: Path) -> int | None:
	lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
	if lock_path.is_symlink():
		raise SupervisorError("supervisor lock path is a symbolic link")
	fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
	os.fchmod(fd, 0o600)
	try:
		fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
		return fd
	except BlockingIOError:
		os.close(fd)
		return None


def validate_cli_wrapper(home: Path, repo: Path) -> Path:
	wrapper = home / ".local/bin/headlesscode"
	try:
		text = wrapper.read_text(encoding="utf-8")
	except OSError as error:
		raise SupervisorError("the supported headlesscode CLI wrapper is unavailable") from error
	if not os.access(wrapper, os.X_OK) or str(repo.resolve()) + "/src/cli.ts" not in text:
		raise SupervisorError("the installed CLI wrapper does not target the configured HeadlessCode checkout")
	if not (repo / "node_modules/.bin/tsx").exists():
		raise SupervisorError("the HeadlessCode runtime dependencies are unavailable")
	return wrapper


def _log(log_file, message: str) -> None:
	stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
	log_file.write(f"{stamp} {message}\n")
	log_file.flush()


class Supervisor:
	def __init__(self, repo: Path, home: Path, *, port: int = PORT,
			 listener: Callable[[Path, int], Listener | None] | None = None,
			 health: Callable[[int], bool] | None = None,
			 popen: Callable[..., subprocess.Popen] | None = None,
			 clock: Callable[[], float] = time.monotonic,
			 sleeper: Callable[[float], None] | None = None,
			 stop_event: threading.Event | None = None):
		self.repo = repo.resolve(strict=True)
		self.home = home.resolve(strict=True)
		self.port = port
		self.listener = listener or (lambda root, p: discover_listener(root, p))
		self.health = health or (lambda p: api_is_healthy(p))
		self.popen = popen or subprocess.Popen
		self.clock = clock
		self.sleeper = sleeper
		self.stop_event = stop_event or _STOP_EVENT
		self.child: subprocess.Popen | None = None
		self.failures = 0
		self.retry_at = 0.0
		self.last_healthy: float | None = None
		self.state_dir = self.home / ".local/state/headlesscode/campaign-control-supervisor"
		self.lock_path = self.state_dir / "supervisor.lock"
		self.pid_path = self.state_dir / "supervisor.pid"
		self.log_path = self.state_dir / "supervisor.log"

	def _prepare_state(self) -> None:
		self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
		stat = self.state_dir.lstat()
		if not self.state_dir.is_dir() or self.state_dir.is_symlink() or stat.st_uid != os.getuid():
			raise SupervisorError("supervisor state directory is not a private directory owned by this user")
		if any(path.is_symlink() for path in (self.lock_path, self.pid_path, self.log_path)):
			raise SupervisorError("supervisor state contains a symbolic link; leaving it untouched")
		os.chmod(self.state_dir, 0o700)

	def step(self, now: float | None = None) -> tuple[str, float]:
		now = self.clock() if now is None else now
		try:
			current = self.listener(self.repo, self.port)
		except SupervisorError as error:
			return str(error), max(1, restart_delay(max(1, self.failures)))
		if current is not None:
			if not self.health(self.port):
				return "campaign-control listener did not pass its status check; leaving it untouched", 5
			self.last_healthy = now
			if self.child is not None and self.child.poll() is not None:
				self.child = None
			self.failures = 0
			self.retry_at = 0
			return "verified campaign-control API is available", POLL_SECONDS
		if self.child is not None:
			code = self.child.poll()
			if code is None:
				return "campaign-control process is starting", 1
			self.child = None
			self.failures += 1
			self.retry_at = now + restart_delay(self.failures)
			return f"campaign-control process exited with status {code}; retry delayed", restart_delay(self.failures)
		if now < self.retry_at:
			return "campaign-control retry backoff is active", self.retry_at - now
		try:
			wrapper = validate_cli_wrapper(self.home, self.repo)
		except SupervisorError as error:
			self.failures += 1
			self.retry_at = now + restart_delay(self.failures)
			return str(error), restart_delay(self.failures)
		if self.log_path.is_symlink():
			return "supervisor log path is a symbolic link", 300
		log_fd = os.open(self.log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
		os.fchmod(log_fd, 0o600)
		log_stream = os.fdopen(log_fd, "a", encoding="utf-8")
		try:
			self.child = self.popen([str(wrapper), "campaign", "serve"], cwd=self.repo,
									 env={"HOME": str(self.home), "PATH": "/usr/local/bin:/usr/bin:/bin"},
								 stdout=log_stream, stderr=subprocess.STDOUT, start_new_session=True)
		finally:
			log_stream.close()
		return "started the fixed campaign-control CLI", 1

	def run(self) -> int:
		self._prepare_state()
		lock_fd = acquire_instance_lock(self.lock_path)
		if lock_fd is None:
			return 0
		if self.pid_path.is_symlink():
			os.close(lock_fd)
			raise SupervisorError("supervisor PID path is a symbolic link")
		pid_fd = os.open(self.pid_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
		try:
			os.fchmod(pid_fd, 0o600)
			os.write(pid_fd, f"{os.getpid()}\n".encode("ascii"))
		finally:
			os.close(pid_fd)
		with self.log_path.open("a", encoding="utf-8") as log_file:
			os.chmod(self.log_path, 0o600)
			_log(log_file, "campaign-control supervisor started")
			try:
				while not self.stop_event.is_set():
					message, delay = self.step()
					_log(log_file, message)
					wait = max(0.1, min(delay, RESTART_MAX_SECONDS))
					if self.sleeper is None:
						self.stop_event.wait(wait)
					else:
						self.sleeper(wait)
			finally:
				_log(log_file, "campaign-control supervisor stopped")
				try:
					if self.pid_path.read_text(encoding="ascii").strip() == str(os.getpid()):
						self.pid_path.unlink()
				except OSError:
					pass
				os.close(lock_fd)
		return 0


def stop_supervisor(repo: Path, home: Path, *, timeout: float = 10.0) -> bool:
	pid_path = home / ".local/state/headlesscode/campaign-control-supervisor/supervisor.pid"
	if pid_path.is_symlink():
		raise SupervisorError("recorded supervisor PID path is a symbolic link; leaving all processes untouched")
	try:
		pid = int(pid_path.read_text(encoding="ascii").strip())
		argv, cwd = process_details(pid)
	except (OSError, ValueError, TypeError):
		return False
	script = str(Path(__file__).resolve())
	if (cwd != str(repo.resolve()) or not argv or script not in argv or "run" not in argv or
		"--repo" not in argv or str(repo.resolve()) not in argv):
		raise SupervisorError("recorded supervisor PID does not match this fixed launcher; leaving it untouched")
	os.kill(pid, signal.SIGTERM)
	deadline = time.monotonic() + timeout
	while time.monotonic() < deadline:
		if process_details(pid) is None:
			return True
		time.sleep(0.1)
	raise SupervisorError("supervisor did not stop; no API process was signalled")


def _handle_stop(_signum, _frame):
	_STOP_EVENT.set()


def main(argv: Sequence[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("action", choices=("run", "check", "stop"))
	parser.add_argument("--repo", type=Path, required=True)
	args = parser.parse_args(argv)
	try:
		repo = args.repo.resolve(strict=True)
		home = Path.home().resolve(strict=True)
		if args.action == "run":
			signal.signal(signal.SIGTERM, _handle_stop)
			signal.signal(signal.SIGINT, _handle_stop)
			return Supervisor(repo, home).run()
		if args.action == "stop":
			stopped = stop_supervisor(repo, home)
			print("Supervisor stopped." if stopped else "No matching supervisor PID was recorded.")
			return 0
		listener = discover_listener(repo)
		if listener is None or not api_is_healthy():
			print("Campaign-control API is unavailable.", file=sys.stderr)
			return 1
		print("Campaign-control API identity and status check passed.")
		return 0
	except (OSError, SupervisorError) as error:
		print(f"campaign-control supervisor: {error}", file=sys.stderr)
		return 1


if __name__ == "__main__":
	raise SystemExit(main())
