#!/bin/sh
# Builds the tablet app: dist-app/inkwise/ (the folder AppLoad loads) and
# dist-app/inkwise-app-<version>.tar.gz. Needs bun and Qt 6's rcc.
#   VERSION=0.2.0 RCC=/path/to/rcc TARGET=bun-linux-arm64 scripts/build-app.sh
set -e
cd "$(dirname "$0")/.."
VERSION=${VERSION:-$(node -p "require('./package.json').version")}
RCC=${RCC:-rcc}
TARGET=${TARGET:-bun-linux-arm64}
OUT=dist-app/inkwise

rm -rf dist-app
mkdir -p "$OUT/backend"
cp app/manifest.json app/icon.png "$OUT/"
cp app/backend/entry "$OUT/backend/entry"
chmod 755 "$OUT/backend/entry"
# Uncompressed: the tablet's Qt may not have zstd.
(cd app && "$RCC" --binary --no-compress -o "../$OUT/resources.rcc" application.qrc)
# The bundle takes core from its build output, so build it first.
npx tsc -b ../core
bun build --compile --minify --target="$TARGET" --define "process.env.INKWISE_VERSION=\"$VERSION\"" src/main.ts --outfile "$OUT/backend/inkwise-rm"
tar --owner=0 --group=0 -czf "dist-app/inkwise-app-$VERSION.tar.gz" -C dist-app inkwise
echo "Built dist-app/inkwise-app-$VERSION.tar.gz"
