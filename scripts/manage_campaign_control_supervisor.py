#!/usr/bin/env python3
"""Install, check, or roll back the campaign-control process supervisor."""

from __future__ import annotations

import argparse
import fcntl
import pwd
import os
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Sequence

from campaign_control_supervisor import SupervisorError, stop_supervisor, validate_cli_wrapper

MARKER = "# headlesscode campaign-control supervisor (managed)"
UNIT = "headlesscode-campaign-control-supervisor.py"
CRON_NAMES = ("cron", "crond")


def supervisor_source() -> Path:
	return Path(__file__).with_name("campaign_control_supervisor.py")


def managed_crontab(existing: str, entry: str) -> str:
	lines = existing.splitlines()
	if MARKER in lines:
		if lines.count(MARKER) != 1:
			raise SupervisorError("duplicate managed cron markers exist; preserving the crontab")
		index = lines.index(MARKER)
		if (index + 1 < len(lines) and lines[index + 1] == entry
				and lines.count(entry) == 1):
			return existing if existing.endswith("\n") else existing + "\n"
		raise SupervisorError("a managed cron marker exists with different content; preserving the crontab")
	if entry in lines:
		raise SupervisorError("the supervisor cron command exists without its marker; preserving the crontab")
	base = existing
	if base and not base.endswith("\n"):
		base += "\n"
	return f"{base}{MARKER}\n{entry}\n"


def remove_managed_crontab(existing: str, entry: str) -> str:
	lines = existing.splitlines(keepends=True)
	plain = existing.splitlines()
	if MARKER not in plain:
		if entry in plain:
			raise SupervisorError("the supervisor cron command has no marker; preserving the crontab")
		return existing
	if plain.count(MARKER) != 1:
		raise SupervisorError("duplicate managed cron markers exist; preserving the crontab")
	index = plain.index(MARKER)
	if index + 1 >= len(plain) or plain[index + 1] != entry:
		raise SupervisorError("the managed cron entry was edited; preserving the crontab")
	return "".join(lines[:index] + lines[index + 2:])


def read_crontab() -> str:
	environment = dict(os.environ)
	environment["LC_ALL"] = "C"
	result = subprocess.run(["crontab", "-l"], capture_output=True, text=False,
							check=False, env=environment)
	if result.returncode == 0:
		return result.stdout.decode("utf-8", "strict")
	user = pwd.getpwuid(os.getuid()).pw_name
	no_crontab = f"no crontab for {user}".encode("utf-8")
	stdout, stderr = result.stdout.strip(), result.stderr.strip()
	if (result.returncode == 1 and stdout in (b"", no_crontab)
			and stderr in (b"", no_crontab) and no_crontab in (stdout, stderr)):
		return ""
	raise SupervisorError("could not read the user's crontab; it was not changed")


def write_crontab(content: str) -> None:
	result = subprocess.run(["crontab", "-"], input=content.encode("utf-8"), capture_output=True, text=False, check=False)
	if result.returncode != 0:
		raise SupervisorError("could not update the user's crontab")


def cron_quote(value: str) -> str:
	# Cron treats percent specially before the shell parses quotes.
	import shlex
	return shlex.quote(value).replace("%", r"\%")


def cron_entry(python: str, installed_script: Path, repo: Path, log_file: Path) -> str:
	command = " ".join(cron_quote(value) for value in
		(python, str(installed_script), "run", "--repo", str(repo)))
	command += " >> " + cron_quote(str(log_file)) + " 2>&1"
	return "@reboot " + command


def cron_daemon_available() -> bool:
	for name in CRON_NAMES:
		if shutil.which("pgrep") and subprocess.run(["pgrep", "-x", name], stdout=subprocess.DEVNULL,
												  stderr=subprocess.DEVNULL, check=False).returncode == 0:
			return True
	return False


def supervisor_active(lock_path: Path) -> bool:
	lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
	if lock_path.is_symlink():
		raise SupervisorError("supervisor lock path is a symbolic link")
	fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
	try:
		try:
			fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
			return False
		except BlockingIOError:
			return True
	finally:
		os.close(fd)


def start_supervisor(script: Path, repo: Path, home: Path, log_file: Path) -> None:
	log_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
	if supervisor_active(log_file.parent / "supervisor.lock"):
		return
	fd = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
	os.fchmod(fd, 0o600)
	with os.fdopen(fd, "a", encoding="utf-8") as log:
		process = subprocess.Popen([sys.executable, str(script), "run", "--repo", str(repo)],
								  cwd=repo, env={"HOME": str(home), "PATH": "/usr/local/bin:/usr/bin:/bin"},
							  stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
							  start_new_session=True)
	for _ in range(30):
		if process.poll() is not None:
			raise SupervisorError("supervisor exited before acquiring its private lock")
		if supervisor_active(log_file.parent / "supervisor.lock"):
			return
		time.sleep(0.1)
	raise SupervisorError("supervisor did not acquire its private lock")


def main(argv: Sequence[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("action", choices=("install", "check", "rollback"))
	parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
	args = parser.parse_args(argv)
	try:
		repo = args.repo.resolve(strict=True)
		home = Path.home().resolve(strict=True)
		libexec = home / ".local/libexec"
		state = home / ".local/state/headlesscode/campaign-control-supervisor"
		installed_script = libexec / UNIT
		log_file = state / "supervisor.log"
		lock_path = state / "supervisor.lock"
		python = str(Path(sys.executable).resolve())
		entry = cron_entry(python, installed_script, repo, log_file)
		current = read_crontab()

		if args.action == "install":
			if not cron_daemon_available():
				raise SupervisorError("the user cron daemon is not running; no files or crontab entries were changed")
			validate_cli_wrapper(home, repo)
			ui = home / "Projects/capsize-web/apps/fleet-campaign-control/dist"
			if not ui.is_dir():
				raise SupervisorError("the campaign-control UI build is missing at the path used by campaign serve")
			libexec.mkdir(parents=True, exist_ok=True, mode=0o700)
			libexec_stat = libexec.lstat()
			if libexec.is_symlink() or libexec_stat.st_uid != os.getuid():
				raise SupervisorError("the user libexec directory is not owned by this account")
			libexec.chmod(0o700)
			source_script = supervisor_source()
			if installed_script.exists() or installed_script.is_symlink():
				installed_stat = installed_script.lstat()
				if not stat.S_ISREG(installed_stat.st_mode) or installed_stat.st_uid != os.getuid():
					raise SupervisorError("the installed supervisor path is not a regular user-owned file")
				if installed_script.read_bytes() != source_script.read_bytes():
					raise SupervisorError("an existing supervisor script differs from this source; preserving it")
				installed_script.chmod(0o700)
			else:
				fd = os.open(installed_script, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
				try:
					os.write(fd, source_script.read_bytes())
					os.fchmod(fd, 0o700)
				finally:
					os.close(fd)
			updated = managed_crontab(current, entry)
			if updated != current:
				write_crontab(updated)
			start_supervisor(installed_script, repo, home, log_file)
			print("Installed the @reboot supervisor and started its lock-protected process.")
			return 0

		if args.action == "check":
			if MARKER not in current.splitlines() or entry not in current.splitlines():
				raise SupervisorError("the managed @reboot entry is missing")
			if not cron_daemon_available():
				raise SupervisorError("the user cron daemon is not running")
			if not supervisor_active(lock_path):
				raise SupervisorError("the process supervisor is not running")
			result = subprocess.run([sys.executable, str(installed_script), "check", "--repo", str(repo)],
								capture_output=True, text=True, check=False)
			if result.returncode != 0:
				raise SupervisorError("the local campaign-control API identity/status check failed")
			print("Cron entry, supervisor lock, and loopback API identity/status are present.")
			return 0

		updated = remove_managed_crontab(current, entry)
		if installed_script.exists():
			installed_stat = installed_script.lstat()
			if not stat.S_ISREG(installed_stat.st_mode) or installed_stat.st_uid != os.getuid():
				raise SupervisorError("the installed supervisor path is not a regular user-owned file; preserving it")
			if installed_script.read_bytes() != supervisor_source().read_bytes():
				raise SupervisorError("the installed supervisor script differs from source; it was preserved")
			result = subprocess.run([sys.executable, str(installed_script), "stop", "--repo", str(repo)],
								capture_output=True, text=True, check=False)
			if result.returncode != 0:
				raise SupervisorError("could not safely stop the recorded supervisor; the API process was not signalled")
		if updated != current:
			write_crontab(updated)
		if installed_script.exists():
			installed_script.unlink()
		print("Removed the managed @reboot entry and stopped the supervisor; campaign API and state were left untouched.")
		return 0
	except (OSError, SupervisorError) as error:
		print(f"campaign-control service: {error}", file=sys.stderr)
		return 1


if __name__ == "__main__":
	raise SystemExit(main())
