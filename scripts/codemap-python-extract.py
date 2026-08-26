#!/usr/bin/env python3
"""Deterministic Python import extractor for headlesscode's codemap (issue #17).

Reads one JSON object from stdin:
    {"root": "<absolute-project-root>", "files": ["rel/path/a.py", ...]}

and prints one JSON object to stdout:
    {"files": {"rel/path/a.py": [{"specifier": "a.b.c", "kind": "import",
                                  "resolved": "rel/or/null"}, ...]}}

Resolution is mechanical and best-effort (stdlib `ast` only, no LLM, no
third-party deps — the AST approach mirrors the sibling project's re-export checker):

  - `import a.b.c`      -> <root>/a/b/c.py, <root>/a/b/c/__init__.py, then
                           the longest existing prefix module (a/b.py, a.py)
  - `from a.b import c` -> module a.b; c resolves to a submodule
                           (a/b/c.py, a/b/c/__init__.py) when one exists,
                           otherwise the edge stays on a.b
  - `from . import x` / `from ..pkg import y` -> relative to the file's dir
                           (level N walks up N-1 directories)

`resolved` is a workspace-relative POSIX path, or null when no candidate file
exists. A file that fails to parse (Python 2 syntax, broken mid-edit) simply
contributes no imports — the module itself is still inventoried by the caller.

Output is deterministic: files sorted, imports sorted, paths POSIX.
"""

import ast
import json
import os
import sys

POSIX = "/"


def posix(p):
    return p.replace(os.sep, POSIX) if os.sep != POSIX else p


def candidates(base_dir, dotted):
    """File candidates for a dotted module name, deepest first."""
    parts = dotted.split(".")
    out = []
    # Full module, then shrinking prefixes: a/b/c.py, a/b/c/__init__.py,
    # a/b.py, a/b/__init__.py, a.py, a/__init__.py
    for i in range(len(parts), 0, -1):
        rel = "/".join(parts[:i])
        if i == len(parts):
            out.append(os.path.join(base_dir, rel + ".py"))
            out.append(os.path.join(base_dir, rel, "__init__.py"))
        else:
            out.append(os.path.join(base_dir, rel + ".py"))
            out.append(os.path.join(base_dir, rel, "__init__.py"))
    return out


def first_existing(cands):
    for c in cands:
        if os.path.isfile(c):
            return c
    return None


def resolve_dotted(root, dotted, base_dir):
    """Resolve a dotted module name relative to root (absolute imports) or
    base_dir (relative imports). Returns abs path or None."""
    if not dotted:
        return None
    if base_dir is None:
        return first_existing(candidates(root, dotted))
    return first_existing(candidates(base_dir, dotted))


def resolve_from_import(root, filename, level, module, names):
    """Resolve a `from X import n` statement. Returns (specifier, abs|None)."""
    base = os.path.dirname(filename)
    # level N: the reference package is N-1 directories up from the file's dir.
    up = base
    for _ in range(level - 1):
        up = os.path.dirname(up)

    if level > 0 and module:
        # `from .m import n` — module m relative to `up`.
        mod = resolve_dotted(root, module, up)
        pkg_dir = os.path.dirname(mod) if mod else None
        for name in names:
            if name == "*":
                return (module, mod)
            sub = resolve_dotted(root, name, pkg_dir or up)
            if sub is not None:
                return ("%s.%s" % (module, name), sub)
        return (module, mod)
    if level > 0 and not module:
        # `from . import x` — module is the current package dir (`up`).
        for name in names:
            if name == "*":
                return (".", None)
            sub = resolve_dotted(root, name, up)
            if sub is not None:
                return (name, sub)
        return (".", None)

    # Absolute: `from a.b import c`.
    mod = resolve_dotted(root, module, root)
    for name in names:
        if name == "*":
            return (module, mod)
        # c may be a submodule of a.b.
        sub = resolve_dotted(root, name, os.path.dirname(mod) if mod else root)
        if sub is not None:
            return ("%s.%s" % (module, name), sub)
    return (module, mod)


def extract_file(root, rel):
    filename = os.path.join(root, rel)
    try:
        with open(filename, "r", encoding="utf-8", errors="replace") as f:
            source = f.read()
        tree = ast.parse(source, filename=filename)
    except (SyntaxError, UnicodeDecodeError, OSError):
        return []
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                resolved = resolve_dotted(root, alias.name, None)
                imports.append(
                    {"specifier": alias.name, "kind": "import",
                     "resolved": posix(os.path.relpath(resolved, root)) if resolved else None}
                )
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            names = [a.name for a in node.names]
            specifier, resolved = resolve_from_import(root, filename, node.level, module, names)
            imports.append(
                {"specifier": specifier, "kind": "from",
                 "resolved": posix(os.path.relpath(resolved, root)) if resolved else None}
            )
    # Deduplicate by (specifier, resolved).
    seen = set()
    out = []
    for imp in imports:
        key = (imp["specifier"], imp["resolved"])
        if key in seen:
            continue
        seen.add(key)
        out.append(imp)
    out.sort(key=lambda i: (i["specifier"], i["resolved"] or ""))
    return out


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        sys.stderr.write("codemap-python-extract: stdin must be JSON {root, files}\n")
        return 2
    root = payload.get("root")
    files = payload.get("files")
    if not isinstance(root, str) or not isinstance(files, list):
        sys.stderr.write("codemap-python-extract: expected {root: str, files: [str]}\n")
        return 2
    out = {}
    for rel in sorted(files):
        if not isinstance(rel, str) or not rel.endswith(".py"):
            continue
        out[rel] = extract_file(root, rel)
    json.dump({"files": out}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
