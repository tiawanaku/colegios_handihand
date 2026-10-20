#!/usr/bin/env bash
# Ingeniería inversa del dashboard con REA (https://github.com/morluto/rea).
#
#   ./run_rea.sh [URL] [OUT_DIR]
#
# Pasos:
#   1. Lanza Chromium con CDP en loopback y abre la URL.
#   2. rea list-browser-targets          -> targetId de la página
#   3. rea inspect-web-page              -> red, formas de JSON, consola, accesibilidad
#   4. rea analyze-web-bundle            -> bundle JS (+ source maps)
#   5. rea capture-web-screenshot        -> captura
#   6. rea export-web-scripts            -> scripts en disco
#   7. rea analyze-javascript-application-> módulos, imports, llamadas a la API
#   8. rea inspect-web-network-capture   -> sobre el HAR que deja harvest.mjs (si existe)
set -euo pipefail

URL="${1:-https://cuidados.elalto.gob.bo/educacion/dashboard/}"
OUT="$(realpath -m "${2:-./out/rea}")"
PORT="${CDP_PORT:-9333}"
REA="${REA:-npx -y rea-agents@6.7.0}"
CHROME="${CHROMIUM_PATH:-$(command -v chromium || command -v chromium-browser || command -v google-chrome || ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)}"
ORIGIN="$(node -e 'console.log(new URL(process.argv[1]).origin)' "$URL")"
OBS_MS="${OBS_MS:-8000}"

mkdir -p "$OUT"
PROFILE="$(mktemp -d)"
EXTRA=()
[ "$(id -u)" = 0 ] && EXTRA+=(--no-sandbox)  # Chromium no arranca como root sin esto
"$CHROME" "${EXTRA[@]}" --headless=new --remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check --window-size=1440,900 \
  about:blank >"$OUT/chrome.log" 2>&1 &
CHROME_PID=$!
trap 'kill $CHROME_PID 2>/dev/null || true; wait $CHROME_PID 2>/dev/null || true; rm -rf "$PROFILE" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null && break; sleep 0.2; done

EP="http://127.0.0.1:$PORT"

# Abre la página nueva y espera a que cargue. La observación pasiva de REA sólo ve lo que
# ocurre DURANTE la ventana, por eso se recarga la página dentro de cada observación.
new_target() { curl -sf -X PUT "$EP/json/new?$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'; }
reload() { node -e '
  const [ep,id]=process.argv.slice(1);
  fetch(ep+"/json/list").then(r=>r.json()).then(l=>{const t=l.find(x=>x.id===id);
    const ws=new WebSocket(t.webSocketDebuggerUrl);ws.onopen=()=>{ws.send(JSON.stringify({id:1,method:"Page.reload",params:{ignoreCache:true}}));setTimeout(()=>process.exit(0),300)}})' "$EP" "$1"; }

TARGET="$(new_target "$URL")"
sleep 5
echo "== target $TARGET ($ORIGIN)"
$REA list-browser-targets "$EP" --allowed-origins "$ORIGIN" --format json >"$OUT/01-targets.json"

echo "== inspect-web-page (${OBS_MS}ms)"
( sleep 1; reload "$TARGET" ) &
$REA inspect-web-page "$EP" "$TARGET" --observation-ms "$OBS_MS" \
  --include-json-body-shapes --include-console-text --include-accessibility-text --include-script-sources \
  --format json >"$OUT/02-inspect-web-page.json" || echo "  (falló, ver archivo)"

echo "== analyze-web-bundle"
( sleep 1; reload "$TARGET" ) &
$REA analyze-web-bundle "$EP" "$TARGET" --observation-ms "$OBS_MS" --fetch-source-maps \
  --format json --full-output >"$OUT/03-analyze-web-bundle.json" || echo "  (falló, ver archivo)"

echo "== capture-web-screenshot"
$REA capture-web-screenshot "$EP" "$TARGET" --format json --full-output >"$OUT/04-screenshot.json" || true

echo "== export-web-scripts"
rm -rf "$OUT/scripts"
# export-web-scripts necesita la Evidence "pelada" (sin --full-output) de inspect-web-page con fuentes
$REA export-web-scripts "$OUT/02-inspect-web-page.json" "$OUT/scripts" --format json >"$OUT/05-export-scripts.json" \
  || echo "  (no se pudieron exportar scripts)"

if [ -d "$OUT/scripts" ]; then
  echo "== analyze-javascript-application"
  $REA analyze-javascript-application "$OUT/scripts" --format json --full-output >"$OUT/06-js-application.json" || true
fi

HAR="$(dirname "$OUT")/harvest/site.har"
if [ -f "$HAR" ]; then
  echo "== inspect-web-network-capture ($HAR)"
  $REA inspect-web-network-capture "$(realpath "$HAR")" har --format json --full-output >"$OUT/07-har.json" || true
fi

echo "Listo. Resultados en $OUT"
ls -la "$OUT"
