#!/usr/bin/env python3
"""Validate a public Android Firebase configuration without exposing its values."""

import json
import os
import stat
import sys

MAX_BYTES = 512 * 1024
EXPECTED_PACKAGE = "cn.net.feitu.openbot.client"
LIMITATIONS = [
    "Checks public configuration structure and package only.",
    "Does not verify ownership, runtime push, SDK initialization, Firebase reachability, signing, or actual provisioning.",
]


class DuplicateKeyError(Exception):
    pass


def reject_constant(_value):
    raise ValueError("non-standard JSON constant")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError()
        result[key] = value
    return result


def parse_args(argv):
    values = {"--file": None, "--expected-project-id": None}
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument in values:
            if values[argument] is not None or index + 1 >= len(argv):
                raise ValueError()
            values[argument] = argv[index + 1]
            index += 2
            continue
        if argument.startswith("--file="):
            option, value = argument.split("=", 1)
        elif argument.startswith("--expected-project-id="):
            option, value = argument.split("=", 1)
        else:
            raise ValueError()
        if option not in values or values[option] is not None or not value:
            raise ValueError()
        values[option] = value
        index += 1
    if not values["--file"]:
        raise ValueError()
    expected = values["--expected-project-id"]
    if expected is not None and not expected.strip():
        raise ValueError()
    return values["--file"], expected


def emit(payload, exit_code):
    sys.stdout.write(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
    return exit_code


def fail(code):
    return emit({"status": "invalid", "error_code": code}, 1)


def read_bounded_file(path):
    try:
        initial = os.lstat(path)
    except (OSError, ValueError):
        raise OSError("unreadable")
    if stat.S_ISLNK(initial.st_mode):
        raise FileNotFoundError("symlink")
    if not stat.S_ISREG(initial.st_mode):
        raise OSError("not_regular")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        raise OSError("unreadable")
    try:
        current = os.fstat(descriptor)
        if not stat.S_ISREG(current.st_mode):
            raise OSError("not_regular")
        if (initial.st_dev, initial.st_ino) != (current.st_dev, current.st_ino):
            raise OSError("changed")
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            descriptor = None
            data = stream.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise OverflowError("oversize")
        return data
    finally:
        if descriptor is not None:
            os.close(descriptor)


def contains_private_credentials(value):
    pending = [value]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            if any(key in current for key in ("private_key", "private_key_id", "client_email")):
                return True
            if current.get("type") == "service_account":
                return True
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
    return False


def nonempty_string(value):
    return isinstance(value, str) and bool(value.strip())


def validate_structure(document):
    if not isinstance(document, dict):
        return False
    project = document.get("project_info")
    clients = document.get("client")
    if not isinstance(project, dict) or not isinstance(clients, list) or not clients:
        return False
    if not nonempty_string(project.get("project_id")):
        return False
    if not nonempty_string(project.get("project_number")):
        return False
    for client in clients:
        if not isinstance(client, dict):
            continue
        info = client.get("client_info")
        if not isinstance(info, dict):
            continue
        android = info.get("android_client_info")
        if isinstance(android, dict) and android.get("package_name") == EXPECTED_PACKAGE:
            return True
    return False


def main(argv):
    try:
        path, expected_project = parse_args(argv)
    except (ValueError, TypeError):
        return emit({"status": "invalid", "error_code": "invalid_arguments"}, 2)

    try:
        data = read_bounded_file(path)
    except FileNotFoundError:
        return fail("symlink_file")
    except OverflowError:
        return fail("oversize_file")
    except OSError:
        return fail("unreadable_file")
    except Exception:
        return fail("unreadable_file")

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return fail("invalid_utf8")

    try:
        document = json.loads(
            text,
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
        )
    except DuplicateKeyError:
        return fail("duplicate_json_key")
    except (json.JSONDecodeError, ValueError, TypeError, RecursionError):
        return fail("invalid_json")

    if contains_private_credentials(document):
        return fail("private_credentials")
    if not validate_structure(document):
        return fail("invalid_public_structure")

    project_id = document["project_info"]["project_id"]
    if expected_project is not None and project_id != expected_project:
        return fail("project_id_mismatch")

    return emit({
        "status": "valid",
        "checks": {
            "public_config_structure": True,
            "android_package": True,
            "private_credentials_absent": True,
            "expected_project_id": expected_project is None or project_id == expected_project,
        },
        "limitations": LIMITATIONS,
    }, 0)


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        raise SystemExit(1)
    except Exception:
        raise SystemExit(fail("validation_failed"))
