# Python conventions

## Tooling

- Identify the project's formatter/linter from its ACTUAL config before
  assuming one: `pyproject.toml`'s `[tool.ruff]` / `[tool.black]`,
  `setup.cfg`, or `.flake8`. A project may pin a specific tool with a
  specific line-length and exclusions (e.g. vendored code); guessing wrong
  wastes a whole run.
- Check how the project runs tests before invoking pytest: Docker
  (`docker-compose exec` / `docker compose run`) vs a local venv. Running
  against the wrong environment gives a false baseline.
- Honor the project's pytest config — `[tool.pytest.ini_options]` in
  `pyproject.toml`, `pytest.ini`, or `tox.ini` — for test paths, markers,
  and options.

## Dependencies

- Identify the actual dependency manager before running install commands:
  `poetry.lock` → poetry, `Pipfile.lock` → pipenv, `requirements*.txt` →
  pip. Installing with the wrong tool creates a parallel lockfile /
  environment and silent drift.
- Prefer the project's virtualenv (`.venv` / `venv`) over the system
  Python for install/run commands.

## Python-specific dynamism

- Never delete or rename a public name without grepping for
  `getattr`-by-name / dispatch-table / string-literal references in
  ADDITION to normal imports — `__all__`, `getattr(module, name)`, and
  plugin/registry patterns mean static-import grep alone misses real call
  sites.
- After splitting a module into submodules, verify every public name the
  original module exposed is still re-exported from the package's
  `__init__.py`.
