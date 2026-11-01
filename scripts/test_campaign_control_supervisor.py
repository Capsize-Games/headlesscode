import http.server
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
from pathlib import Path

from campaign_control_supervisor import (
	Listener,
	Supervisor,
	SupervisorError,
	acquire_instance_lock,
	api_is_healthy,
	discover_listener,
	listener_matches_campaign,
	parse_ss_row,
	restart_delay,
	process_details,
	stop_supervisor,
)
import manage_campaign_control_supervisor as manager
from manage_campaign_control_supervisor import MARKER, managed_crontab, remove_managed_crontab


class SyntheticStatusHandler(http.server.BaseHTTPRequestHandler):
	state_path: Path

	def do_GET(self):
		if self.path != "/api/campaign-control":
			self.send_error(404)
			return
		payload = self.state_path.read_bytes()
		self.send_response(200)
		self.send_header("Content-Type", "application/json")
		self.send_header("Content-Length", str(len(payload)))
		self.end_headers()
		self.wfile.write(payload)

	def log_message(self, *_args):
		pass


class FakeChild:
	def __init__(self):
		self.returncode = None

	def poll(self):
		return self.returncode


class CampaignControlSupervisorTests(unittest.TestCase):
	def setUp(self):
		self.temp = tempfile.TemporaryDirectory(prefix="campaign-supervisor-test-")
		self.root = Path(self.temp.name)
		self.repo = self.root / "headlesscode"
		self.home = self.root / "home"
		(self.repo / "src").mkdir(parents=True)
		(self.repo / "node_modules/.bin").mkdir(parents=True)
		(self.repo / "src/cli.ts").write_text("", encoding="utf-8")
		(self.repo / "node_modules/.bin/tsx").write_text("", encoding="utf-8")
		(self.home / ".local/bin").mkdir(parents=True)
		wrapper = self.home / ".local/bin/headlesscode"
		wrapper.write_text(f'#!/bin/sh\nexec "{self.repo}/node_modules/.bin/tsx" "{self.repo}/src/cli.ts" "$@"\n', encoding="utf-8")
		wrapper.chmod(0o700)
		os.chmod(self.root, 0o700)

	def tearDown(self):
		self.temp.cleanup()

	def test_listener_identity_is_exact_and_loopback_only(self):
		valid = Listener("127.0.0.1", 4391, 1234,
			("/usr/bin/node", str(self.repo / "src/cli.ts"), "campaign", "serve"), str(self.repo))
		self.assertTrue(listener_matches_campaign(valid, self.repo))
		self.assertFalse(listener_matches_campaign(Listener("0.0.0.0", 4391, 1234, valid.argv, valid.cwd), self.repo))
		self.assertFalse(listener_matches_campaign(Listener("127.0.0.1", 4391, 1234, valid.argv, str(self.root)), self.repo))
		self.assertFalse(listener_matches_campaign(Listener("127.0.0.1", 4391, 1234,
			("/usr/bin/node", str(self.repo / "src/cli.ts"), "campaign", "tick"), valid.cwd), self.repo))

	def test_ss_listener_discovery_uses_proc_identity_and_fails_closed(self):
		pid = 1234
		proc_root = self.root / "proc"
		proc_dir = proc_root / str(pid)
		proc_dir.mkdir(parents=True)
		(proc_dir / "cmdline").write_bytes(("/usr/bin/node\0" + str(self.repo / "src/cli.ts") +
			"\0campaign\0serve\0").encode())
		(proc_dir / "stat").write_text("1234 (node) S 1 2 3\n", encoding="ascii")
		(proc_dir / "cwd").symlink_to(self.repo, target_is_directory=True)
		line = 'LISTEN 0 128 127.0.0.1:4391 0.0.0.0:* users:(("node",pid=1234,fd=20))'
		self.assertEqual(parse_ss_row(line), ("127.0.0.1", 4391, pid))
		def run(_args, **_kwargs):
			return subprocess.CompletedProcess([], 0, stdout=line + "\n", stderr="")
		listener = discover_listener(self.repo, command=run, proc_root=proc_root)
		self.assertEqual(listener.pid, pid)
		def ambiguous(_args, **_kwargs):
			return subprocess.CompletedProcess([], 0, stdout=line + "\ninvalid listener row\n", stderr="")
		with self.assertRaises(SupervisorError):
			discover_listener(self.repo, command=ambiguous, proc_root=proc_root)

	def test_synthetic_status_server_survives_process_restart_with_disposable_state(self):
		state = self.root / "synthetic-state.json"
		state.write_text(json.dumps({"epoch": 5, "enabled": False}), encoding="utf-8")
		SyntheticStatusHandler.state_path = state
		server = http.server.HTTPServer(("127.0.0.1", 0), SyntheticStatusHandler)
		thread = threading.Thread(target=server.serve_forever, daemon=True)
		thread.start()
		port = server.server_address[1]
		listener = Listener("127.0.0.1", port, 4321,
			("/usr/bin/node", str(self.repo / "src/cli.ts"), "campaign", "serve"), str(self.repo))
		try:
			self.assertTrue(listener_matches_campaign(listener, self.repo, port))
			self.assertTrue(api_is_healthy(port))
			first_response = __import__("urllib.request").request.urlopen(f"http://127.0.0.1:{port}/api/campaign-control")
			self.assertEqual(json.load(first_response), {"epoch": 5, "enabled": False})
			first_response.close()
			server.shutdown()
			thread.join(timeout=2)
			server.server_close()
			server = http.server.HTTPServer(("127.0.0.1", port), SyntheticStatusHandler)
			thread = threading.Thread(target=server.serve_forever, daemon=True)
			thread.start()
			self.assertTrue(api_is_healthy(port))
			second_response = __import__("urllib.request").request.urlopen(f"http://127.0.0.1:{port}/api/campaign-control")
			self.assertEqual(json.load(second_response), {"epoch": 5, "enabled": False})
			second_response.close()
		finally:
			server.shutdown()
			thread.join(timeout=2)
			server.server_close()

	def test_duplicate_supervisor_lock_is_rejected(self):
		lock_path = self.root / "state/supervisor.lock"
		first = acquire_instance_lock(lock_path)
		self.assertIsNotNone(first)
		try:
			self.assertIsNone(acquire_instance_lock(lock_path))
		finally:
			os.close(first)
		self.assertIsNotNone(acquire_instance_lock(lock_path))

	def test_restart_uses_capped_backoff_and_only_fixed_cli(self):
		children = []
		launches = []
		def popen(args, **kwargs):
			launches.append((args, kwargs))
			child = FakeChild()
			children.append(child)
			return child
		now = [0.0]
		supervisor = Supervisor(self.repo, self.home, port=4391,
			listener=lambda _repo, _port: None, popen=popen, clock=lambda: now[0])
		supervisor._prepare_state()
		message, _ = supervisor.step()
		self.assertIn("started the fixed", message)
		self.assertEqual(len(launches), 1)
		self.assertEqual(launches[0][0], [str(self.home / ".local/bin/headlesscode"), "campaign", "serve"])
		self.assertEqual(launches[0][1]["env"], {"HOME": str(self.home), "PATH": "/usr/local/bin:/usr/bin:/bin"})
		children[0].returncode = 1
		message, delay = supervisor.step(now=1.0)
		self.assertIn("retry delayed", message)
		self.assertEqual(delay, 5)
		message, _ = supervisor.step(now=5.0)
		self.assertIn("backoff", message)
		self.assertEqual(len(launches), 1)
		now[0] = 6.0
		supervisor.step()
		self.assertEqual(len(launches), 2)

	def test_unknown_listener_is_never_started_over(self):
		def unknown(_repo, _port):
			raise SupervisorError("port 4391 belongs to an unrecognized listener; leaving it untouched")
		launches = []
		supervisor = Supervisor(self.repo, self.home, listener=unknown,
			popen=lambda *args, **kwargs: launches.append(args))
		message, delay = supervisor.step(now=0)
		self.assertIn("unrecognized listener", message)
		self.assertEqual(delay, 5)
		self.assertEqual(launches, [])

	def test_long_backoff_wait_is_interrupted_promptly_for_rollback(self):
		stop_event = threading.Event()
		entered = threading.Event()
		def unknown(_repo, _port):
			entered.set()
			raise SupervisorError("port 4391 belongs to an unrecognized listener; leaving it untouched")
		supervisor = Supervisor(self.repo, self.home, listener=unknown, stop_event=stop_event)
		supervisor.failures = 7
		result = []
		worker = threading.Thread(target=lambda: result.append(supervisor.run()), daemon=True)
		started = time.monotonic()
		worker.start()
		self.assertTrue(entered.wait(timeout=1))
		stop_event.set()
		worker.join(timeout=1)
		self.assertFalse(worker.is_alive())
		self.assertEqual(result, [0])
		self.assertLess(time.monotonic() - started, 1)

	def test_injected_sleeper_remains_deterministic(self):
		stop_event = threading.Event()
		delays = []
		def unknown(_repo, _port):
			raise SupervisorError("port 4391 belongs to an unrecognized listener; leaving it untouched")
		def sleeper(delay):
			delays.append(delay)
			stop_event.set()
		supervisor = Supervisor(self.repo, self.home, listener=unknown,
			sleeper=sleeper, stop_event=stop_event)
		self.assertEqual(supervisor.run(), 0)
		self.assertEqual(delays, [5])

	def test_stop_verifies_supervisor_pid_and_treats_zombie_as_stopped(self):
		pid = 4321
		proc_root = self.root / "proc"
		proc_dir = proc_root / str(pid)
		proc_dir.mkdir(parents=True)
		(proc_dir / "stat").write_text("4321 (python) Z 1 2 3\n", encoding="ascii")
		self.assertIsNone(process_details(pid, proc_root))
		pid_path = self.home / ".local/state/headlesscode/campaign-control-supervisor/supervisor.pid"
		pid_path.parent.mkdir(parents=True)
		pid_path.write_text(str(pid), encoding="ascii")
		script = str(Path(__file__).with_name("campaign_control_supervisor.py").resolve())
		identity = (("/usr/bin/python3", script, "run", "--repo", str(self.repo)), str(self.repo))
		with mock.patch("campaign_control_supervisor.process_details", side_effect=[identity, None]), \
			 mock.patch("campaign_control_supervisor.os.kill") as kill:
			self.assertTrue(stop_supervisor(self.repo, self.home))
		kill.assert_called_once_with(pid, __import__("signal").SIGTERM)

	def test_restart_backoff_caps_at_five_minutes(self):
		self.assertEqual([restart_delay(value) for value in range(1, 8)], [5, 10, 20, 40, 80, 160, 300])

	def test_cron_install_and_rollback_preserve_existing_controls(self):
		old = "# keep this comment\r\n15 * * * * /usr/local/bin/existing-campaign-control\r\n"
		entry = "@reboot /usr/bin/python3 /home/user/private/supervisor.py run --repo /home/user/headlesscode"
		installed = managed_crontab(old, entry)
		self.assertTrue(installed.startswith(old))
		self.assertIn(MARKER, installed)
		self.assertEqual(remove_managed_crontab(installed, entry), old)

	def test_cron_edited_managed_line_fails_closed(self):
		with self.assertRaises(SupervisorError):
			managed_crontab(f"{MARKER}\n@reboot changed-command\n", "@reboot expected-command")
		with self.assertRaises(SupervisorError):
			remove_managed_crontab(f"{MARKER}\n@reboot edited-command\n", "@reboot expected-command")

	def test_duplicate_markers_are_rejected_even_if_first_entry_matches(self):
		entry = "@reboot /usr/bin/python3 /home/user/supervisor.py run"
		with self.assertRaises(SupervisorError):
			managed_crontab(f"{MARKER}\n{entry}\n{MARKER}\nother\n", entry)

	def test_crontab_read_only_accepts_only_the_verified_empty_table_notice(self):
		user = manager.pwd.getpwuid(os.getuid()).pw_name
		with mock.patch.object(manager.subprocess, "run", return_value=subprocess.CompletedProcess(
			["crontab", "-l"], 1, b"", f"no crontab for {user}\n".encode())):
			self.assertEqual(manager.read_crontab(), "")
		for result in (
			subprocess.CompletedProcess(["crontab", "-l"], 1, b"", b""),
			subprocess.CompletedProcess(["crontab", "-l"], 1, b"", b"permission denied\n"),
			subprocess.CompletedProcess(["crontab", "-l"], 2, b"", f"no crontab for {user}\n".encode()),
		):
			with mock.patch.object(manager.subprocess, "run", return_value=result):
				with self.assertRaises(SupervisorError):
					manager.read_crontab()

	def test_rollback_validates_crontab_before_stopping_or_removing_supervisor(self):
		libexec = self.home / ".local/libexec"
		libexec.mkdir(parents=True)
		copy = libexec / manager.UNIT
		copy.write_bytes(manager.supervisor_source().read_bytes())
		copy.chmod(0o700)
		edited = f"{MARKER}\n@reboot locally-edited command\n"
		with mock.patch.dict(os.environ, {"HOME": str(self.home)}, clear=False), \
			 mock.patch.object(manager, "read_crontab", return_value=edited), \
			 mock.patch.object(manager, "write_crontab") as write, \
			 mock.patch.object(manager.subprocess, "run") as run:
			self.assertEqual(manager.main(["rollback", "--repo", str(self.repo)]), 1)
		write.assert_not_called()
		run.assert_not_called()
		self.assertTrue(copy.is_file())

	def test_installer_adds_and_removes_only_its_private_artifact_and_cron_line(self):
		ui = self.home / "Projects/capsize-web/apps/fleet-campaign-control/dist"
		ui.mkdir(parents=True)
		old = "# unrelated\r\n0 4 * * * /home/user/campaign-tick\r\n"
		written = []
		with mock.patch.dict(os.environ, {"HOME": str(self.home)}, clear=False), \
			 mock.patch.object(manager, "cron_daemon_available", return_value=True), \
			 mock.patch.object(manager, "validate_cli_wrapper", return_value=self.home / ".local/bin/headlesscode"), \
			 mock.patch.object(manager, "read_crontab", return_value=old), \
			 mock.patch.object(manager, "write_crontab", side_effect=written.append), \
			 mock.patch.object(manager, "start_supervisor") as start:
			self.assertEqual(manager.main(["install", "--repo", str(self.repo)]), 0)
		self.assertEqual(len(written), 1)
		installed = written[0]
		self.assertTrue(installed.startswith(old))
		self.assertEqual(installed.splitlines().count(MARKER), 1)
		self.assertEqual(len([line for line in installed.splitlines() if line.startswith("@reboot ")]), 1)
		copy = self.home / ".local/libexec/headlesscode-campaign-control-supervisor.py"
		self.assertEqual(copy.read_bytes(), Path(manager.__file__).with_name("campaign_control_supervisor.py").read_bytes())
		self.assertEqual(copy.stat().st_mode & 0o777, 0o700)
		start.assert_called_once()
		written.clear()
		with mock.patch.dict(os.environ, {"HOME": str(self.home)}, clear=False), \
			 mock.patch.object(manager, "read_crontab", return_value=installed), \
			 mock.patch.object(manager, "write_crontab", side_effect=written.append), \
			 mock.patch.object(manager.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")):
			self.assertEqual(manager.main(["rollback", "--repo", str(self.repo)]), 0)
		self.assertEqual(written, [old])
		self.assertFalse(copy.exists())


if __name__ == "__main__":
	unittest.main(verbosity=2)
