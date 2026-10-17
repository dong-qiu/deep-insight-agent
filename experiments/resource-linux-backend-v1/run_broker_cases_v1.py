#!/usr/bin/env python3
"""Bounded Linux engineering evidence, never original resource qualification."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import selectors
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone

LIMITS = {"seconds": 120, "grace": 2, "stdout": 1048576,
          "stderr": 2097152, "combined": 2097152, "fixture": 67108864, "batch": 1200}
CORE_NAMES = ["policy_v1.c", "policy_v1.h", "io_budget_v1.c", "io_budget_v1.h",
              "lifetime_journal_v1.c", "lifetime_journal_v1.h", "lifetime_sink_v1.c", "lifetime_sink_v1.h"]
EXPECTED = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "R01"]

def utc():
    return datetime.now(timezone.utc).isoformat()

def identity(path):
    path = Path(path)
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise ValueError("input is not single regular file: " + str(path))
    data = path.read_bytes()
    return {"path": str(path), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

def create(path, data):
    if not isinstance(data, bytes):
        data = (json.dumps(data, indent=2, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    st = os.fstat(fd)
    if st.st_uid != os.getuid() or st.st_nlink != 1 or st.st_size != 0 or stat.S_IMODE(st.st_mode) != 0o600:
        os.close(fd)
        raise ValueError("new evidence birth mode/owner")
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return identity(path)

def run(output, tag, argv, cwd, batch_start, inputs=None):
    if time.monotonic() - batch_start >= LIMITS["batch"]:
        raise RuntimeError("batch exhausted before " + tag)
    plan = {"actualUTC": utc(), "argv": [str(x) for x in argv], "cwd": str(cwd),
            "limits": LIMITS, "inputs": inputs, "originalQualification": False}
    create(output / (tag + ".plan.json"), plan)
    started = time.monotonic()
    def child_limits():
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    process = subprocess.Popen([str(x) for x in argv], cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True, preexec_fn=child_limits)
    selector = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    eof = {}
    for name, stream in [("stdout", process.stdout), ("stderr", process.stderr)]:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, name)
    timeout = overflow = forced_close = False
    terminated = None
    def group_signal(sig):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
    while selector.get_map():
        elapsed = time.monotonic() - started
        batch_elapsed = time.monotonic() - batch_start
        if (elapsed >= LIMITS["seconds"] or batch_elapsed >= LIMITS["batch"]) and not timeout:
            timeout = True
            terminated = time.monotonic()
            group_signal(signal.SIGTERM)
        if terminated is not None and time.monotonic() - terminated >= LIMITS["grace"]:
            group_signal(signal.SIGKILL)
        if elapsed >= LIMITS["seconds"] + LIMITS["grace"] + 2:
            forced_close = True
            group_signal(signal.SIGKILL)
            break
        for key, _ in selector.select(0.03):
            block = os.read(key.fileobj.fileno(), 65536)
            if not block:
                eof[key.data] = utc()
                selector.unregister(key.fileobj)
                key.fileobj.close()
                continue
            if (len(buffers[key.data]) + len(block) > LIMITS[key.data]
                    or sum(map(len, buffers.values())) + len(block) > LIMITS["combined"]):
                overflow = True
                group_signal(signal.SIGKILL)
            else:
                buffers[key.data].extend(block)
    # A child may close both streams and continue; wait is independently bounded.
    remaining = max(0.01, LIMITS["seconds"] - (time.monotonic() - started))
    try:
        code = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        timeout = True
        group_signal(signal.SIGTERM)
        try:
            code = process.wait(timeout=LIMITS["grace"])
        except subprocess.TimeoutExpired:
            group_signal(signal.SIGKILL)
            code = process.wait(timeout=2)
    if code != 0 or timeout or overflow or forced_close:
        group_signal(signal.SIGKILL)  # Owned experiment session only; keep failure.
    for key in list(selector.get_map().values()):
        selector.unregister(key.fileobj)
        key.fileobj.close()
    selector.close()
    streams = {name: create(output / (tag + "." + name), bytes(data)) for name, data in buffers.items()}
    result = {"actualStartUTC": plan["actualUTC"], "actualStopUTC": utc(), "exitCode": code,
              "waitCompleted": True, "EOF": eof, "timeout": timeout, "overflow": overflow,
              "forcedPipeClosure": forced_close, "elapsedSeconds": time.monotonic() - started,
              "streams": streams, "complete": code == 0 and len(eof) == 2 and not (timeout or overflow or forced_close),
              "qualification": False}
    create(output / (tag + ".result.json"), result)
    return result, bytes(buffers["stdout"])

def assert_case(name, result):
    if result.get("case") != name or result.get("qualification") is not False:
        raise ValueError("case identity/nonqualification")
    if result.get("result") != ("COUNTEREXAMPLE_OBSERVED" if name == "R01" else "PASS"):
        raise ValueError("missing expected case result")
    if name == "B07":
        for key in ["journal_active", "journal_bytes", "journal_calls", "payload_bytes"]:
            if result.get(key) != 0:
                raise ValueError("journal negative effect: " + key)
        if result.get("adapter_hold") is not True:
            raise ValueError("missing lifecycle capability did not hold")
        return
    if result.get("children_reaped") != result.get("fixture_children"):
        raise ValueError("real fixture wait missing")
    if name == "B01":
        if [result.get(x) for x in ["stdout_observed", "stderr_observed", "used_stdout", "used_combined", "allowed", "denied"]] != [1048576, 1048576, 1048576, 2097152, 512, 2]:
            raise ValueError("canonical real pipe boundaries")
    elif name == "B02":
        if [result.get(x) for x in ["stdout_observed", "allowed", "denied", "fixture_children"]] != [1048576, 1, 1, 2]:
            raise ValueError("shared last-chunk accounting")
    elif name == "B03":
        if [result.get(x) for x in ["strict_denials", "notifications", "stdout_observed", "stderr_observed"]] != [12, 0, 0, 0]:
            raise ValueError("strict mutation/alternate denial")
    elif name == "B04":
        if result.get("known_partial") != 4096 or result.get("stdout_observed") != result.get("prefill_bytes", -1) + 4096 or result.get("used_stdout") != result.get("stdout_observed"):
            raise ValueError("known partial actual counters")
    elif name == "B05":
        if [result.get(x) for x in ["actual_guard_bytes", "stdout_observed", "used_stdout", "send_failed", "core_held", "adapter_hold"]] != [1, 1, 1, 1, False, True]:
            raise ValueError("known effect retained after control failure")
    elif name == "B06":
        if [result.get(x) for x in ["actual_guard_bytes", "stdout_observed", "used_stdout"]] != [1, 1, 1] or result.get("mutator_tid", 0) <= 0:
            raise ValueError("copied pointer green effect")
    elif name == "R01":
        if [result.get(x) for x in ["stdout_observed", "used_stdout", "core_held", "adapter_hold"]] != [2, 1, True, True] or result.get("mutator_tid", 0) <= 0:
            raise ValueError("unsafe CONTINUE counterexample not observed")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--compiler", required=True, choices=["gcc", "clang"])
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--core-dir", type=Path)
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        parser.error("actual Linux x86_64 required; unsupported is FAIL/NOTRUN")
    os.umask(0o077)
    here = Path(__file__).resolve().parent
    core = args.core_dir.resolve() if args.core_dir else here.parent.parent / "resource" / "core"
    output = args.output.absolute()
    output.mkdir(mode=0o700)
    if output.is_symlink() or stat.S_IMODE(output.stat().st_mode) != 0o700:
        raise ValueError("fresh private output directory")
    batch_start = time.monotonic()
    manifest = json.loads((here / "broker_cases_v1.json").read_bytes())
    if ([x["id"] for x in manifest["cases"]] != EXPECTED or manifest["positiveBuild"] != EXPECTED[:7]
            or manifest["negativeOnlyBuild"] != ["R01"] or manifest["qualification"] is not False):
        raise ValueError("exact frozen eight-case manifest required")
    paths = [here / "broker_discriminator_v1.c", here / "broker_cases_v1.json", Path(__file__).resolve()] + [core / n for n in CORE_NAMES]
    source_inputs = [identity(p) for p in paths]
    compiler = shutil.which(args.compiler)
    if not compiler:
        raise ValueError("compiler unavailable")
    compiler = str(Path(compiler).resolve())
    inputs = {"sourceFiles": source_inputs, "compiler": identity(Path(compiler)),
              "python": identity(Path(sys.executable).resolve()), "uname": list(os.uname()),
              "actualUTC": utc(), "limits": LIMITS, "qualification": False}
    create(output / "inputs-before-v1.json", inputs)
    errors = []
    results = []
    for tag, argv in [("compiler-version", [compiler, "--version"]),
                      ("compiler-target", [compiler, "-dumpmachine"]),
                      ("linker-path", [compiler, "-print-prog-name=ld"]),
                      ("libc-version", ["ldd", "--version"])]:
        record, _ = run(output, tag, argv, here, batch_start, inputs)
        if not record["complete"]:
            errors.append(tag)
    linker_name = (output / "linker-path.stdout").read_text().strip()
    linker = shutil.which(linker_name) if not Path(linker_name).is_absolute() else linker_name
    if linker and Path(linker).is_file():
        linker_bound = identity(Path(linker).resolve())
        create(output / "actual-linker-identity.json", linker_bound)
        linker_result, _ = run(output, "linker-version", [linker, "--version"], here, batch_start, linker_bound)
        if not linker_result["complete"]:
            errors.append("linker-version")
    else:
        errors.append("actual-linker-identity")
    source = here / "broker_discriminator_v1.c"
    dependency, raw_deps = run(output, "actual-headers", [compiler, "-std=c11", "-pthread", "-I", core, "-M", source], here, batch_start, inputs)
    if dependency["complete"]:
        tokens = shlex.split(raw_deps.decode().replace("\\\n", " ").split(":", 1)[1])
        headers = [identity(Path(x).resolve()) for x in sorted(set(tokens)) if Path(x).is_file()]
        create(output / "actual-header-identities.json", headers)
    else:
        errors.append("actual-headers")
    binaries = {}
    for build, negative in [("positive", 0), ("negative-only", 1)]:
        binary = output / ("broker-" + build)
        create(binary, b"")
        argv = [compiler, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-pthread", "-I", core,
                "-DP31_NEGATIVE_CONTROL=" + str(negative), source] + [core / x for x in CORE_NAMES if x.endswith(".c")] + ["-o", binary]
        record, _ = run(output, "compile-" + build, argv, here, batch_start, inputs)
        if not record["complete"]:
            errors.append("compile-" + build)
            continue
        os.chmod(binary, 0o700, follow_symlinks=False)
        bound = identity(binary)
        description, raw = run(output, "filter-before-" + build, [binary, "--describe"], here, batch_start, bound)
        if not description["complete"]:
            errors.append("filter-before-" + build)
            continue
        filters = json.loads(raw)
        if filters["negative_build"] != negative or len(filters["filters"]) != 3:
            raise ValueError("compiled filter identity")
        create(output / ("compiled-filter-identities-" + build + ".json"),
               [{"index": i, "bytes": len(bytes.fromhex(h)), "sha256": hashlib.sha256(bytes.fromhex(h)).hexdigest()} for i, h in enumerate(filters["filters"])])
        run(output, "linked-runtime-" + build, ["ldd", binary], here, batch_start, bound)
        binaries[build] = (binary, bound)
    for name in EXPECTED:
        build = "negative-only" if name == "R01" else "positive"
        if build not in binaries:
            results.append({"case": name, "status": "NOTRUN", "reason": "build/filter unavailable"})
            errors.append(name)
            continue
        binary, bound = binaries[build]
        directory = output / name
        directory.mkdir(mode=0o700)
        record, raw = run(output, "case-" + name, [binary, name, directory], here, batch_start, bound)
        try:
            if not record["complete"]:
                raise ValueError("real exit/wait/EOF or feature failure")
            value = json.loads(raw)
            assert_case(name, value)
            results.append({"case": name, "status": value["result"], "actual": value})
        except (ValueError, KeyError, TypeError) as exc:
            errors.append(name)
            results.append({"case": name, "status": "FAIL", "reason": str(exc)})
    if [identity(p) for p in paths] != source_inputs:
        errors.append("source changed during run")
    total = 0
    members = []
    for path in sorted(output.rglob("*")):
        if path.is_symlink():
            raise ValueError("evidence symlink")
        if path.is_file():
            item = identity(path)
            total += item["bytes"]
            members.append(item)
    if total > LIMITS["fixture"]:
        errors.append("fixture aggregate exceeded")
    summary = {"schema": "p31-broker-engineering-result-v1", "actualStopUTC": utc(), "compiler": args.compiler,
               "cases": results, "expectedCases": EXPECTED, "caseCount": len(results),
               "positivePass": sum(x["status"] == "PASS" for x in results),
               "counterexampleObserved": sum(x["status"] == "COUNTEREXAMPLE_OBSERVED" for x in results),
               "errors": errors, "status": "FAIL" if errors else "PASS", "fixtureBytesBeforeSummary": total,
               "qualification": False, "lifetimeEligibility": "UNSUPPORTED", "memoryBound": "UNKNOWN",
               "hold": 435, "safeRollback": None, "deployment": "BLOCKED", "inputs": inputs, "members": members}
    create(output / "summary.json", summary)
    print(json.dumps({k: summary[k] for k in ["status", "caseCount", "positivePass", "counterexampleObserved", "errors", "qualification"]}))
    return 1 if errors else 0

if __name__ == "__main__":
    sys.exit(main())
