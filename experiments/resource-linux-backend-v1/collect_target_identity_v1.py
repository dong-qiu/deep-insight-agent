"""P32 finite, unprivileged, read-only target census; not resource qualification."""
import argparse
import datetime
import errno
import hashlib
import json
import os
import pathlib
import platform
import re
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys
import time

FILE_CAP = 524288
COMMAND_CAP = 65536
TOTAL_READ_CAP = 67108864
TOTAL_READ = 0


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_file(path, cap=FILE_CAP):
    global TOTAL_READ
    try:
        with open(path, "rb") as stream:
            raw = stream.read(cap + 1)
        TOTAL_READ += len(raw)
        if TOTAL_READ > TOTAL_READ_CAP:
            raise RuntimeError("aggregate read limit")
        if len(raw) > cap:
            return {"status": "over_limit", "limit": cap}, None
        return {"status": "observed", "bytes": len(raw), "sha256": digest(raw)}, raw
    except OSError as exc:
        return {"status": "unavailable", "errno": exc.errno,
                "reason": errno.errorcode.get(exc.errno, "OS_ERROR")}, None


def text_file(path):
    result, raw = read_file(path)
    if raw is not None:
        try:
            result["text"] = raw.decode("utf-8").strip()
        except UnicodeDecodeError:
            result["status"] = "non_utf8"
    return result


def note_build_ids(raw):
    """Parse whole little-endian Linux ELF notes, never infer a binary mapping."""
    offset = 0
    ids = []
    while offset < len(raw):
        if len(raw) - offset < 12:
            raise ValueError("truncated note header")
        namesz, descsz, kind = struct.unpack_from("<III", raw, offset)
        offset += 12
        end_name = offset + namesz
        end_desc = ((end_name + 3) & ~3) + descsz
        next_note = (end_desc + 3) & ~3
        if end_name > len(raw) or next_note > len(raw):
            raise ValueError("truncated note body")
        name = raw[offset:end_name]
        desc = raw[(end_name + 3) & ~3:end_desc]
        if kind == 3 and name.rstrip(b"\0") == b"GNU":
            ids.append(desc.hex())
        offset = next_note
    return ids


def cgroup_path(raw):
    rows = [line[3:] for line in raw.decode("utf-8").splitlines()
            if line.startswith("0::")]
    if len(rows) != 1:
        raise ValueError("expected exactly one unified cgroup membership")
    value = pathlib.PurePosixPath(rows[0])
    if not value.is_absolute() or ".." in value.parts:
        raise ValueError("unsafe cgroup path")
    return value


def command(argv):
    """Fixed caller argv only; bounded capture and own process-group shutdown."""
    start = time.monotonic()
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True,
                               env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
    selector = selectors.DefaultSelector()
    data = {"stdout": bytearray(), "stderr": bytearray()}
    eof = {"stdout": False, "stderr": False}
    for name, stream in [("stdout", process.stdout), ("stderr", process.stderr)]:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, name)
    reason = None
    term_at = None
    forced = False
    while selector.get_map() or process.poll() is None:
        elapsed = time.monotonic() - start
        if elapsed > 8 and reason is None:
            reason = "timeout"
        if reason and term_at is None:
            term_at = time.monotonic()
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if term_at and time.monotonic() - term_at > 1:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if term_at and time.monotonic() - term_at > 2 and selector.get_map():
            forced = True
            for key in list(selector.get_map().values()):
                selector.unregister(key.fileobj)
                key.fileobj.close()
        for key, _ in selector.select(0.02):
            raw = os.read(key.fileobj.fileno(), 8192)
            name = key.data
            if not raw:
                eof[name] = True
                selector.unregister(key.fileobj)
                key.fileobj.close()
                continue
            room = COMMAND_CAP - sum(map(len, data.values()))
            if len(raw) > room:
                reason = reason or "overflow"
            data[name].extend(raw[:max(0, room)])
    code = process.wait()
    selector.close()
    return {"argv": argv, "exit": code, "waitCompleted": True, "EOF": eof,
            "forcedPipeClosure": forced, "stopReason": reason,
            "status": "observed" if code == 0 and not reason and all(eof.values()) else "failed",
            **{name: {"bytes": len(raw), "sha256": digest(raw),
                      "text": raw.decode("utf-8", errors="replace")}
               for name, raw in data.items()}}


def save(path, value):
    raw = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    if len(raw) > FILE_CAP:
        raise RuntimeError("identity output exceeds cap")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def save_raw(root, name, raw):
    path = root / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return {"path": name, "bytes": len(raw), "sha256": digest(raw)}


def collect(output_root):
    release = platform.release()
    if sys.platform != "linux" or platform.machine() != "x86_64":
        raise RuntimeError("only Linux x86_64 identity observation is supported")
    if not re.fullmatch(r"[A-Za-z0-9._+-]{1,120}", release):
        raise RuntimeError("unsafe kernel release")
    result = {"schema": "p32-target-identity-v1", "actualUTC": datetime.datetime.now(
        datetime.timezone.utc).isoformat(), "kernel": {"release": release,
        "machine": platform.machine(), "versionSignature": text_file("/proc/version_signature")},
        "source": text_file(__file__), "uid": os.geteuid(), "gid": os.getegid(),
        "qualification": False, "writesToKernelOrCgroup": False}
    # Source contents already versioned, but only retain their whole-byte identity here.
    result["source"].pop("text", None)
    notes, raw = read_file("/sys/kernel/notes")
    if raw is not None:
        notes["ownedRaw"] = save_raw(output_root, "running-notes.bin", raw)
        try:
            notes["GNUbuildIDs"] = note_build_ids(raw)
        except ValueError as exc:
            notes["parseStatus"] = str(exc)
    result["kernel"]["runningNotes"] = notes
    config_result, config_raw = read_file("/boot/config-" + release)
    result["kernel"]["config"] = config_result
    if config_raw is not None:
        config_result["ownedRaw"] = save_raw(output_root, "disk-config.raw", config_raw)
        try:
            config_result["text"] = config_raw.decode("utf-8")
        except UnicodeDecodeError:
            config_result["status"] = "non_utf8"
    # Config hash is useful; expose only named relevant options, not the entire config.
    config = result["kernel"]["config"].pop("text", None)
    if config is not None:
        names = ("CONFIG_MEMCG", "CONFIG_MEMCG_KMEM", "CONFIG_CGROUPS", "CONFIG_CGROUP_PIDS",
                 "CONFIG_SMP", "CONFIG_NR_CPUS", "CONFIG_PREEMPT", "CONFIG_PREEMPT_RCU",
                 "CONFIG_SECCOMP", "CONFIG_SECCOMP_FILTER", "CONFIG_BPF", "CONFIG_DEBUG_INFO_BTF")
        result["kernel"]["config"]["selectedOptions"] = [
            line for line in config.splitlines() if any(
                line.startswith(name + "=") or line == "# " + name + " is not set" for name in names)]
    # One exact matching image read, bounded20MiB. Failure is not retried via other paths.
    image_result, image_raw = read_file("/boot/vmlinuz-" + release, cap=20971520)
    result["kernel"]["bootImage"] = image_result
    image_result["runningBinaryBinding"] = False
    if image_raw is not None:
        image_result["ownedRaw"] = save_raw(output_root, "disk-boot-image.bin", image_raw)
    try:
        image = os.stat("/boot/vmlinuz-" + release)
        image_result["stat"] = {"bytes": image.st_size, "mode": oct(stat.S_IMODE(image.st_mode)),
                                "uid": image.st_uid, "gid": image.st_gid}
    except OSError as exc:
        image_result["stat"] = {"status": "unavailable", "errno": exc.errno}
    result["cpu"] = {name: text_file("/sys/devices/system/cpu/" + name)
                     for name in ["online", "possible", "present", "offline", "isolated"]}
    status, raw = read_file("/proc/self/status")
    if raw is not None:
        status["selected"] = [line for line in raw.decode().splitlines()
                              if line.split(":", 1)[0] in ["CapEff", "NoNewPrivs", "Seccomp", "Threads"]]
    result["controllerStatus"] = status
    group, raw = read_file("/proc/self/cgroup")
    roots = {"root": pathlib.Path("/sys/fs/cgroup")}
    if raw is not None:
        try:
            path = cgroup_path(raw)
            group["relativePathSHA256"] = digest(str(path).encode())
            roots["self"] = roots["root"].joinpath(*path.parts[1:])
        except ValueError as exc:
            group["parseStatus"] = str(exc)
    result["cgroupMembership"] = group
    names = ["cgroup.controllers", "cgroup.subtree_control", "cgroup.type", "cgroup.events",
             "memory.max", "memory.current", "memory.swap.max", "memory.swap.current",
             "memory.peak", "pids.max", "pids.current", "cpuset.cpus.effective"]
    result["cgroup"] = {label: {name: text_file(root / name) for name in names}
                        for label, root in roots.items()}
    # Only selected cgroup2 mount fields; no host mount/process/network inventory.
    mount, raw = read_file("/proc/self/mountinfo")
    if raw is not None:
        mount["cgroup2"] = [{"mountpoint": line.split()[4], "options": line.split()[5],
                            "superOptions": line.split(" - ", 1)[1].split()[2]}
                           for line in raw.decode().splitlines() if " - cgroup2 " in line]
    result["cgroupMount"] = mount
    result["tools"] = {}
    for name in ["gcc", "clang", "ld", "python3", "dpkg-query"]:
        path = shutil.which(name, path="/usr/bin:/bin")
        if path is None:
            result["tools"][name] = {"status": "unavailable"}
            continue
        identity, _ = read_file(os.path.realpath(path), cap=16777216)
        result["tools"][name] = {"path": path, "resolved": os.path.realpath(path),
                                "identity": identity, "version": command([path, "--version"])}
    query = shutil.which("dpkg-query", path="/usr/bin:/bin")
    result["matchingKernelPackages"] = command([query, "-W",
        "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${db:Status-Abbrev}\n",
        "linux-image-" + release, "linux-modules-" + release, "linux-headers-" + release]) if query else {
            "status": "unavailable"}
    result["provenanceLimits"] = ["Running notes are unsigned observed bytes, not source/config attestation.",
        "Installed package metadata does not prove which binary is running.",
        "This hosted instance is ephemeral; future fixtures require fresh same-target drift checks.",
        "Readable cgroup values/privilege metadata are not delegated-write authority or a memory bound.",
        "No prebirth/final kernel-release producer was exercised or authenticated."]
    result["totalBytesRead"] = TOTAL_READ
    return result


def self_test():
    import io
    from unittest import mock
    note = struct.pack("<III", 4, 4, 3) + b"GNU\0" + b"1234"
    assert note_build_ids(note) == ["31323334"]
    for raw in [b"x", note[:-1]]:
        try:
            note_build_ids(raw)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted truncated note")
    assert str(cgroup_path(b"0::/a/b\n")) == "/a/b"
    for raw in [b"0::/a/../b\n", b"1:cpu:/x\n", b"0::/a\n0::/b\n"]:
        try:
            cgroup_path(raw)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted invalid membership")
    with mock.patch("builtins.open", side_effect=PermissionError(errno.EACCES, "fixture")):
        status, raw = read_file("unused-fixture-path")
        assert raw is None and status == {"status": "unavailable", "errno": 13, "reason": "EACCES"}
    with mock.patch("builtins.open", return_value=io.BytesIO(b"abcd")):
        status, raw = read_file("unused-fixture-path", cap=3)
        assert raw is None and status == {"status": "over_limit", "limit": 3}
    with mock.patch(__name__ + ".read_file", return_value=({"status": "observed"}, b"\xff")):
        assert text_file("unused-fixture-path")["status"] == "non_utf8"
    print("p32 isolated parser/error-path self-tests: 10 passed; no target census or resource payload")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif args.output is not None:
        save(args.output, collect(args.output.parent))
    else:
        parser.error("--output or --self-test required")
