#!/usr/bin/env bash
# 旧源码+本地配置投递路径已停用。此脚本保留为旧命令的拒绝入口。
set -euo pipefail
echo "拒绝部署：ops/aws/deploy.sh 会覆盖生产配置，已停用。" >&2
echo "生产发布唯一入口：GitHub Actions → Deploy Production Image（main 的不可变镜像）。" >&2
echo "首次主机配置请参阅 docs/launch/operations.md §8；不要用源码投递代替发布。" >&2
exit 2
