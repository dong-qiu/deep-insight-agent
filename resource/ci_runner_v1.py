"""Trusted engineering CI only; not the original resource executor/qualification."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import resource
import selectors
import shutil
import signal
import subprocess
import sys
import time

FLAGS = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow",
         "-Wstrict-prototypes", "-Wformat=2", "-pedantic", "-pthread", "-O2"]
SOURCES = ["resource/core/policy_v1.c", "resource/core/io_budget_v1.c",
           "resource/tests/io_budget_test_v1.c"]
INPUTS = SOURCES + ["resource/core/policy_v1.h", "resource/core/io_budget_v1.h",
                   "resource/tests/io_budget_cases_v1.json", "resource/ci_runner_v1.py"]
BUILD_CAP = 64 * 1024 * 1024


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def identity(path):
    path = Path(path)
    data = path.read_bytes()
    return {"path": str(path), "realpath": str(path.resolve()), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest()}


def save(path, data):
    raw = data if isinstance(data, bytes) else (json.dumps(data, indent=2) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(raw)
        out.flush()
        os.fsync(out.fileno())
    return identity(path)


def child_limits():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def run_child(argv, cwd, output, label, seconds=120, grace=2):
    """Own session only. Keep exact exit, wait and each EOF separate from PASS."""
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "LANG": "C"}
    save(output / (label + ".plan.json"), {
        "UTC": now(), "argv": argv, "cwd": str(cwd), "env": env,
        "executable": identity(argv[0]), "seconds": seconds, "grace": grace,
        "stdoutCap": 1048576, "stderrCap": 2097152, "combinedCap": 2097152,
        "ownedBuildCap": BUILD_CAP, "RLIMIT_CORE": 0})
    start = now()
    clock = time.monotonic()
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            start_new_session=True, preexec_fn=child_limits)
    sel = selectors.DefaultSelector()
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    eof = {key: False for key in streams}
    timeout = overflow = forced = disk_overflow = False
    stopping = None
    for name, pipe in [("stdout", proc.stdout), ("stderr", proc.stderr)]:
        os.set_blocking(pipe.fileno(), False)
        sel.register(pipe, selectors.EVENT_READ, name)
    while sel.get_map() or proc.poll() is None:
        elapsed = time.monotonic() - clock
        # Logical owned-file observation, not a physical quota/cgroup attestation.
        disk_overflow |= sum(p.stat().st_size for p in output.rglob("*")
                             if p.is_file() and not p.is_symlink()) > BUILD_CAP
        if stopping is None and (elapsed > seconds or overflow or disk_overflow):
            timeout = elapsed > seconds
            stopping = time.monotonic()
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        if stopping is not None and time.monotonic() - stopping > grace:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if stopping is not None and time.monotonic() - stopping > grace + 2:
            if sel.get_map():
                forced = True
                for key in list(sel.get_map().values()):
                    sel.unregister(key.fileobj)
                    key.fileobj.close()
        for key, _ in sel.select(0.02):
            data = os.read(key.fileobj.fileno(), 65536)
            name = key.data
            if not data:
                eof[name] = True
                sel.unregister(key.fileobj)
                key.fileobj.close()
                continue
            cap = 1048576 if name == "stdout" else 2097152
            room = min(cap - len(streams[name]), 2097152 - sum(map(len, streams.values())))
            overflow |= len(data) > room
            streams[name].extend(data[:max(0, room)])
    code = proc.wait()
    sel.close()
    result = {"actualStartUTC": start, "actualSTOPUTC": now(), "exitCode": code,
              "waitCompleted": True, "EOF": eof, "timeout": timeout,
              "overflow": overflow, "forcedPipeClosure": forced,
              "ownedBuildOverflow": disk_overflow,
              "streams": {k: save(output / (label + "." + k), bytes(v))
                          for k, v in streams.items()}}
    result["passed"] = code == 0 and all(eof.values()) and not any(
        [timeout, overflow, forced, disk_overflow])
    save(output / (label + ".result.json"), result)
    return result


def require_pass(result, phase):
    if not result["passed"]:
        raise RuntimeError(phase + " did not pass; retain raw result")


def command_text(result):
    return Path(result["streams"]["stdout"]["path"]).read_text(encoding="utf-8")


def selected_linker(compiler, root, output):
    result = run_child([compiler, "-print-prog-name=ld"], root, output, "selected-linker")
    require_pass(result, "selected linker query")
    value = command_text(result).strip()
    if not value or "\n" in value:
        raise RuntimeError("UNKNOWN compiler-selected linker")
    # A basename returned by the driver uses the same fixed child PATH, not host PATH.
    path = value if Path(value).is_absolute() else shutil.which(value, path="/usr/bin:/bin")
    if not path:
        raise RuntimeError("UNKNOWN selected linker resolution")
    linker = str(Path(path).resolve(strict=True))
    proof = {"driverSelectedValue": value, "identity": identity(linker),
             "resolutionPATH": "/usr/bin:/bin"}
    save(output / "linker-identity.json", proof)
    require_pass(run_child([linker, "--version"], root, output, "linker-version"),
                 "selected linker version")
    return proof


def elf_runtime(binary, root, output):
    """Inspect only the trusted just-produced ELF, before executing its C tests."""
    proof = {"status": "UNKNOWN", "binary": identity(binary), "dependencies": []}
    try:
        readelf = shutil.which("readelf", path="/usr/bin:/bin")
        ldd = shutil.which("ldd", path="/usr/bin:/bin")
        if not readelf or not ldd:
            raise RuntimeError("UNKNOWN ELF/runtime identity tools")
        headers = run_child([readelf, "--program-headers", "--wide", str(binary)],
                            root, output, "elf-program-headers")
        require_pass(headers, "ELF program headers")
        values = re.findall(r"Requesting program interpreter: ([^\]\n]+)", command_text(headers))
        if len(values) != 1 or not Path(values[0]).is_absolute():
            raise RuntimeError("UNKNOWN ELF PT_INTERP")
        proof["interpreter"] = identity(values[0])
        loaded = run_child([ldd, str(binary)], root, output, "elf-loaded-dependencies")
        require_pass(loaded, "ELF loaded dependency resolution")
        has_libc = False
        for line in command_text(loaded).splitlines():
            line = line.strip()
            if not line:
                continue
            # vDSO is virtual: no disk identity; do not invent a hash/process-map proof.
            if re.fullmatch(r"linux-vdso\.so\.\d+ \(0x[0-9a-fA-F]+\)", line):
                proof["dependencies"].append({"line": line, "kind": "virtual-vdso",
                                              "diskIdentity": None})
                continue
            match = re.fullmatch(r"(?:(\S+) => )?(/\S+) \(0x[0-9a-fA-F]+\)", line)
            if not match:
                raise RuntimeError("UNKNOWN dynamic dependency resolution: " + line)
            name, path = match.groups()
            proof["dependencies"].append({"name": name, "identity": identity(path)})
            has_libc |= name is not None and name.startswith("libc.so.")
        if not has_libc:
            raise RuntimeError("UNKNOWN dynamically resolved libc")
        proof["status"] = "COMPLETE_FILE_IDENTITIES_ONLY"
        proof["notFullProcessMapsOrOriginalResourceQualification"] = True
    except Exception as error:
        proof["error"] = {"type": type(error).__name__, "message": str(error)}
        save(output / "runtime-identity.json", proof)
        raise
    save(output / "runtime-identity.json", proof)
    return proof


def compile_and_test(compiler, root, output, capture_runtime=False):
    binary = output / "io_budget_test_v1"
    compile_result = run_child([compiler, *FLAGS, "-Wl,-v", *SOURCES, "-o", str(binary)],
                               root, output, "compile")
    require_pass(compile_result, "compile")
    os.chmod(binary, 0o700)
    binary_identity = identity(binary)
    if capture_runtime:
        elf_runtime(binary, root, output)
    test_result = run_child([str(binary)], root, output, "test")
    require_pass(test_result, "test")
    if capture_runtime:
        proof = json.loads((output / "runtime-identity.json").read_bytes())
        files = [proof["interpreter"]] + [item["identity"] for item in proof["dependencies"]
                                        if "identity" in item]
        if any(identity(item["path"]) != item for item in files):
            raise RuntimeError("runtime file identity changed during C test")
    if identity(binary) != binary_identity:
        raise RuntimeError("test executable changed")
    return binary_identity


def gate(mode, lane):
    # Existing selected-path gate remains mandatory independently of this gate.
    return (mode == "full" and lane == "success") or (mode == "docs" and lane == "skipped")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--compiler", required=True, choices=["gcc", "clang"])
    run.add_argument("--output", required=True, type=Path)
    check = sub.add_parser("gate")
    check.add_argument("--mode", required=True)
    check.add_argument("--lane", required=True)
    args = parser.parse_args()
    if args.command == "gate":
        return 0 if gate(args.mode, args.lane) else 1
    if platform.system() != "Linux":
        parser.error("hosted Linux engineering lane required; use supervisor tests elsewhere")
    output = args.output
    if not output.is_absolute():
        parser.error("output must be an absolute new owned directory")
    os.umask(0o077)
    output.mkdir(mode=0o700)  # Refuse preexisting output; never erase old failures.
    root = Path(__file__).resolve().parent.parent
    summary = {"schema": "resource-linux-c-engineering-v1", "actualStartUTC": now(),
               "compiler": args.compiler, "platform": platform.platform(),
               "runnerImage": {key: os.environ.get(key) for key in
                               ["ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH"]},
               "run": {"id": os.environ.get("GITHUB_RUN_ID"),
                       "attempt": os.environ.get("GITHUB_RUN_ATTEMPT")},
               "eventHead": os.environ.get("RESOURCE_EVENT_HEAD"),
               "testedCommit": os.environ.get("GITHUB_SHA"), "qualification": False,
               "originalResourceReadyGates": 0, "passed": False}
    try:
        if not all(summary["runnerImage"].values()) or summary["runnerImage"]["RUNNER_OS"] != "Linux":
            raise RuntimeError("UNKNOWN hosted Linux runner image/OS/arch")
        compiler = str(Path(shutil.which(args.compiler) or "MISSING").resolve(strict=True))
        inputs = [identity(root / name) for name in INPUTS]
        summary["inputs"] = inputs
        summary["compilerIdentity"] = identity(compiler)
        save(output / "source-plan.json", summary)
        for label, argv in [("compiler-version", [compiler, "--version"]),
                            ("compiler-target", [compiler, "-dumpmachine"]),
                            ("checkout", ["/usr/bin/git", "rev-parse", "HEAD", "HEAD^{tree}"])]:
            require_pass(run_child(argv, root, output, label), label)
        summary["selectedLinker"] = selected_linker(compiler, root, output)
        summary["binary"] = compile_and_test(compiler, root, output, capture_runtime=True)
        summary["runtime"] = identity(output / "runtime-identity.json")
        if identity(compiler) != summary["compilerIdentity"] or identity(
                summary["selectedLinker"]["identity"]["path"]) != summary["selectedLinker"]["identity"]:
            raise RuntimeError("compiler/linker identity changed")
        if [identity(root / name) for name in INPUTS] != inputs:
            raise RuntimeError("source changed after freeze")
        summary["passed"] = True
    except Exception as error:
        summary["error"] = {"type": type(error).__name__, "message": str(error)}
    summary["actualSTOPUTC"] = now()
    save(output / "summary.json", summary)
    print(json.dumps({"compiler": args.compiler, "passed": summary["passed"],
                      "output": str(output), "qualification": False}))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
