#!/usr/bin/env python3
"""Read-only, heuristic preflight for the two deployment draft files."""
import json
import re
import shlex
import sys
from pathlib import Path

EXPECTED_ENV = {
    "OPENBOT_SELF_HOSTED_HOST": "127.0.0.1",
    "OPENBOT_SELF_HOSTED_PORT": "3187",
    "OPENBOT_SELF_HOSTED_MODE": "production",
    "OPENBOT_SELF_HOSTED_EXPOSE_DEVELOPMENT_CODE": "false",
}
EXPECTED_DIRECTIVES = {
    "User": "openbot-gateway",
    "ProtectSystem": "strict",
    "ProtectHome": "true",
    "NoNewPrivileges": "true",
}
ACCOUNT_PATHS = {
    "/v1/auth/email/start", "/v1/auth/email/verify", "/v1/me",
    "/v1/auth/logout", "/.well-known/jwks.json", "/health/live",
    "/health/ready",
}
BLOCKERS = [
    "production-secret-provisioning-not-verified",
    "production-db-init-import-not-verified",
    "relay-not-implemented",
]


def emit(value):
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))


def clean_lines(text):
    result = []
    for raw in text.splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            result.append(line)
    return result


def brace_delta(line):
    delta = 0
    quote = None
    escaped = False
    for char in line:
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote:
            escaped = True
            continue
        if char in ("'", '"'):
            if quote == char:
                quote = None
            elif quote is None:
                quote = char
            continue
        if quote is None:
            if char == "{":
                delta += 1
            elif char == "}":
                delta -= 1
    return delta


def caddy_blocks(lines):
    blocks = []
    current = None
    depth = 0
    invalid = []
    for line in lines:
        if depth == 0:
            match = re.match(r"^([^\s{]+)\s*\{", line)
            if match:
                current = [match.group(1), []]
                depth = 1
            elif "{" in line or "}" in line:
                invalid.append("unrecognized top-level block")
            continue
        current[1].append(line)
        depth += brace_delta(line)
        if depth == 0:
            blocks.append(current)
            current = None
        elif depth < 0:
            invalid.append("unmatched closing brace")
            depth = 0
            current = None
    if depth != 0:
        invalid.append("unclosed block")
    return blocks, invalid


def check_caddy(text, checks):
    lines = clean_lines(text)
    blocks, invalid = caddy_blocks(lines)
    headers = [name for name, _ in blocks]
    if invalid:
        checks.append(("caddy-block-structure", False, "; ".join(invalid)))
    else:
        checks.append(("caddy-block-structure", True, "top-level blocks are brace-balanced heuristically"))
    allowed = {"api.feitu.net.cn", "connect.feitu.net.cn"}
    checks.append((
        "caddy-allowed-site-headers",
        len(headers) == 2 and set(headers) == allowed,
        "expected exactly the two allowed site headers",
    ))
    by_name = {name: body for name, body in blocks}
    api = by_name.get("api.feitu.net.cn", [])
    connect = by_name.get("connect.feitu.net.cn", [])
    proxy_ok = any(re.match(r"^reverse_proxy\s+127\.0\.0\.1:3187(?:\s|$)", line) for line in api)
    checks.append(("api-reverse-proxy", proxy_ok, "API site must proxy to 127.0.0.1:3187"))
    respond_ok = any(re.search(r"\brespond\s+(?:\"[^\"]*\"|'[^']*')\s+503(?:\s|$)", line) for line in connect)
    checks.append(("connect-explicit-503", respond_ok, "connect site must use a quoted message followed by 503"))
    account_lines = [line for line in api if re.match(r"^@account\s+path\b", line)]
    tokens = []
    for line in account_lines:
        try:
            parts = line.split(None, 2)
            tokens.extend(shlex.split(parts[2]) if len(parts) == 3 else ["<invalid>"])
        except ValueError:
            tokens.append("<invalid>")
    paths_ok = len(account_lines) == 1 and set(tokens) == ACCOUNT_PATHS and len(tokens) == len(ACCOUNT_PATHS)
    checks.append(("account-path-allowlist", paths_ok, "@account path tokens must exactly match the known allowlist"))


def check_service(text, checks):
    lines = clean_lines(text)
    env = {}
    env_dupes = set()
    for line in lines:
        if not line.startswith("Environment="):
            continue
        assignment = line[len("Environment="):]
        if "=" not in assignment:
            continue
        key, value = assignment.split("=", 1)
        if key in EXPECTED_ENV:
            if key in env and env[key] != value:
                env_dupes.add(key)
            env[key] = value
    for key, expected in EXPECTED_ENV.items():
        checks.append(("environment-" + key, env.get(key) == expected, "expected Environment setting is absent or differs"))
    checks.append(("environment-duplicate-consistency", not env_dupes, "contradictory duplicate Environment settings found" if env_dupes else "no contradictory duplicate Environment settings"))
    directives = {}
    directive_dupes = set()
    for line in lines:
        match = re.match(r"^([A-Za-z][A-Za-z0-9]*)=(.*)$", line)
        if not match:
            continue
        key, value = match.groups()
        if key in EXPECTED_DIRECTIVES:
            if key in directives and directives[key] != value:
                directive_dupes.add(key)
            directives[key] = value
    for key, expected in EXPECTED_DIRECTIVES.items():
        checks.append(("systemd-" + key, directives.get(key) == expected, "expected systemd directive is absent or differs"))
    checks.append(("systemd-duplicate-consistency", not directive_dupes, "contradictory duplicate systemd directives found" if directive_dupes else "no contradictory duplicate systemd directives"))


def run(template_dir):
    base = Path(template_dir) if template_dir is not None else Path(__file__).resolve().parent
    paths = [base / "Caddyfile", base / "openbot-account-gateway.service"]
    texts = {}
    read_errors = []
    for path in paths:
        try:
            texts[path.name] = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            read_errors.append((str(path), "file is missing"))
        except UnicodeDecodeError:
            read_errors.append((str(path), "file is not valid UTF-8"))
        except OSError:
            read_errors.append((str(path), "file is unreadable"))
    checks = []
    if "Caddyfile" in texts:
        check_caddy(texts["Caddyfile"], checks)
    if "openbot-account-gateway.service" in texts:
        check_service(texts["openbot-account-gateway.service"], checks)
    for path, detail in read_errors:
        checks.append(("read-" + Path(path).name, False, detail))
    failed = [name for name, ok, _ in checks if not ok]
    payload = {
        "status": "deployment-blocked",
        "checks": [{"name": name, "status": "passed" if ok else "failed", "detail": detail} for name, ok, detail in checks],
        "blockers": BLOCKERS,
        "summary": {
            "status": "deployment-blocked",
            "passed_checks": len(checks) - len(failed),
            "failed_checks": len(failed),
            "failed_static_checks": failed,
            "exit_code": 1,
        },
        "limitations": [
            "External website status is unverified.",
            "Runtime compatibility is unverified.",
            "This is heuristic text checking, not full Caddyfile or systemd syntax validation.",
            "No deployment, secret loading, database initialization/import, or relay is performed.",
        ],
    }
    emit(payload)
    return 1


def main():
    args = sys.argv[1:]
    template_dir = None
    i = 0
    try:
        while i < len(args):
            arg = args[i]
            if arg == "--template-dir":
                if template_dir is not None or i + 1 >= len(args) or not args[i + 1]:
                    raise ValueError("invalid arguments")
                template_dir = args[i + 1]
                i += 2
                continue
            raise ValueError("invalid arguments")
    except ValueError as exc:
        emit({"status": "invalid", "checks": [], "blockers": BLOCKERS, "summary": {"status": "invalid", "exit_code": 2}, "limitations": [str(exc)]})
        return 2
    return run(template_dir)


if __name__ == "__main__":
    sys.exit(main())
