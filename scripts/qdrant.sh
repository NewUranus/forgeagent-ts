#!/bin/sh
# Local Qdrant without Docker: `install` downloads the pinned release binary and checks its
# SHA-256; `start` runs it in the foreground with data under .qdrant/storage (REST on :6333).
set -eu
VERSION=1.20.0
DIR="$(cd "$(dirname "$0")/.." && pwd)/.qdrant"
BIN="$DIR/bin/qdrant"

case "${1:-start}" in
  install)
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) ASSET=qdrant-aarch64-apple-darwin.tar.gz; SHA=531904e822050790bb8c1da6705f801ee48b91eb4c229d0d605ff06f6331b20a ;;
      Darwin-x86_64) ASSET=qdrant-x86_64-apple-darwin.tar.gz; SHA=94a2e6f6b8ef3a3b5756a11172fd66554ac753e0a71c1d8d8b5349356c084f4d ;;
      Linux-x86_64) ASSET=qdrant-x86_64-unknown-linux-gnu.tar.gz; SHA=2361f3df0dedfef31f5444f9f15bd15d6b4a6cba6ad952daecc5fbe3867c5ee6 ;;
      Linux-aarch64) ASSET=qdrant-aarch64-unknown-linux-musl.tar.gz; SHA=bd8a458b8ef8006ce2c603c5bd6d1d973e39d787f794008dd959112e747c3bb7 ;;
      *) echo "不支持的平台：$(uname -s)-$(uname -m)" >&2; exit 1 ;;
    esac
    mkdir -p "$DIR/download" "$DIR/bin"
    curl -L --retry 5 --speed-time 30 --speed-limit 1000 -C - -o "$DIR/download/$ASSET" \
      "https://github.com/qdrant/qdrant/releases/download/v$VERSION/$ASSET"
    echo "$SHA  $DIR/download/$ASSET" | shasum -a 256 -c
    tar -xzf "$DIR/download/$ASSET" -C "$DIR/bin" qdrant
    "$BIN" --version
    ;;
  start)
    [ -x "$BIN" ] || { echo "没有找到 $BIN，请先运行 npm run qdrant:install" >&2; exit 1; }
    mkdir -p "$DIR/storage" "$DIR/snapshots"
    cd "$DIR"
    QDRANT__STORAGE__STORAGE_PATH="$DIR/storage" \
    QDRANT__STORAGE__SNAPSHOTS_PATH="$DIR/snapshots" \
    QDRANT__TELEMETRY_DISABLED=true \
      exec "$BIN"
    ;;
  *) echo "用法：scripts/qdrant.sh install|start" >&2; exit 1 ;;
esac
