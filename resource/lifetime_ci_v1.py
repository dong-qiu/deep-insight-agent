"""Linux engineering lane for the pending journal; no original resource qualification."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys

from ci_runner_v1 import (FLAGS, command_text, elf_runtime, identity, now,
                          require_pass, run_child, save, selected_linker)

SOURCES = ["resource/core/lifetime_journal_v1.c", "resource/core/lifetime_sink_v1.c",
           "resource/tests/lifetime_journal_test_v1.c"]
INPUTS = SOURCES + ["resource/core/lifetime_journal_v1.h", "resource/core/lifetime_sink_v1.h",
                   "resource/tests/lifetime_cases_v1.json", "resource/lifetime_ci_v1.py",
                   "resource/ci_runner_v1.py"]


def lane(compiler, root, output, negative):
    output.mkdir(mode=0o700)
    binary = output / "lifetime_test_v1"
    flags = FLAGS + (["-DLJ_TEST_IO"] if negative else [])
    require_pass(run_child([compiler, *flags, "-Wl,-v", *SOURCES, "-o", str(binary)],
                           root, output, "compile"), "lifetime compile")
    os.chmod(binary, 0o700)
    frozen = identity(binary)
    runtime = elf_runtime(binary, root, output)
    fixtures = output / "fixtures"
    fixtures.mkdir(mode=0o700)
    result = run_child([str(binary), str(fixtures)], root, output, "test")
    require_pass(result, "lifetime test")
    text = command_text(result)
    match = re.fullmatch(r"(?:PASS lifetime [^\n]+\n)+lifetime groups=(\d+) checks=(\d+) qualification=false\n", text)
    expected = 7 if negative else 29
    if (match is None or int(match[1]) != expected or int(match[2]) < expected
            or text.count("PASS lifetime ") != expected):
        raise RuntimeError("UNKNOWN or incomplete finite lifetime case result")
    files = [runtime["interpreter"]] + [item["identity"] for item in runtime["dependencies"] if "identity" in item]
    if identity(binary) != frozen or any(identity(item["path"]) != item for item in files):
        raise RuntimeError("lifetime binary/runtime file drift")
    fixtures_proof = [identity(path) for path in sorted(fixtures.iterdir())]
    if sum(item["bytes"] for item in fixtures_proof) > 67108864:
        raise RuntimeError("owned fixture file overflow")
    save(output / "fixture-files.json", fixtures_proof)
    return {"binary": frozen, "groups": expected, "checks": int(match[2]),
            "realUnwrappedPositive": not negative, "negativeOnlyFaultBuild": negative,
            "fixtureFiles": len(fixtures_proof), "passed": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", required=True, choices=["gcc", "clang"])
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if platform.system() != "Linux" or not args.output.is_absolute():
        parser.error("Linux engineering lane and absolute new owned output required")
    os.umask(0o077)
    args.output.mkdir(mode=0o700)
    root = Path(__file__).resolve().parent.parent
    summary = {"schema": "resource-lifetime-engineering-v1", "startUTC": now(),
               "passed": False, "qualification": False, "originalResourceReadyGates": 0,
               "eventHead": os.environ.get("RESOURCE_EVENT_HEAD"), "testedCommit": os.environ.get("GITHUB_SHA"),
               "run": {"id": os.environ.get("GITHUB_RUN_ID"), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT")},
               "runnerImage": {key: os.environ.get(key) for key in ["ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH"]}}
    try:
        if not all(summary["runnerImage"].values()) or summary["runnerImage"]["RUNNER_OS"] != "Linux":
            raise RuntimeError("UNKNOWN hosted Linux runner identity")
        compiler = str(Path(shutil.which(args.compiler) or "MISSING").resolve(strict=True))
        inputs = [identity(root / name) for name in INPUTS]
        summary["inputs"] = inputs
        summary["compiler"] = identity(compiler)
        save(args.output / "source-plan.json", summary)
        for name, argv in [("compiler-version", [compiler, "--version"]),
                           ("compiler-target", [compiler, "-dumpmachine"]),
                           ("checkout", ["/usr/bin/git", "rev-parse", "HEAD", "HEAD^{tree}"])]:
            require_pass(run_child(argv, root, args.output, name), name)
        summary["linker"] = selected_linker(compiler, root, args.output)
        summary["positive"] = lane(compiler, root, args.output / "positive", False)
        summary["negative"] = lane(compiler, root, args.output / "negative", True)
        if ([identity(root / name) for name in INPUTS] != inputs or identity(compiler) != summary["compiler"]
                or identity(summary["linker"]["identity"]["path"]) != summary["linker"]["identity"]):
            raise RuntimeError("lifetime source/compiler/linker drift")
        summary["passed"] = True
    except Exception as error:
        summary["error"] = {"type": type(error).__name__, "message": str(error)}
    summary["stopUTC"] = now()
    save(args.output / "summary.json", summary)
    print(json.dumps({"passed": summary["passed"], "output": str(args.output), "qualification": False}))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
