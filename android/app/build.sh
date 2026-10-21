#!/bin/bash
# Compila la app de Android de OPEN SOURCE PARIZ sin Android Studio:
# portal → assets, aapt2 (recursos), javac + dx (código), alineado + firma v1/v2/v3.
#
# Rutas configurables por variable de entorno (con valores por defecto relativos al repositorio):
#   HERRAMIENTAS  carpeta con aapt2_64, android-34.jar, uber-apk-signer.jar y dex2jar
#   PORTAL        carpeta del código del portal (la que tiene build.mjs)
#   LLAVERO       carpeta con la clave de firma: <LLAVERO>/pariz-release.jks y <LLAVERO>/clave.txt
#                 (la clave NO está en el repositorio: se guarda aparte, en privado)
set -e
unset JAVA_TOOL_OPTIONS
AQUI=$(cd "$(dirname "$0")" && pwd)
RAIZ=$(cd "$AQUI/../.." && pwd)
T=${HERRAMIENTAS:-$HOME/apk/tools}
P=$AQUI
PORTAL=${PORTAL:-$RAIZ/portal}
LLAVERO=${LLAVERO:-$HOME/apk/keys}
O=$P/out
DX_JAR=$(ls $T/d2j/*/lib/d2j-external-*.jar)
rm -rf $O && mkdir -p $O/cls $O/gen $O/assets/www

# 1) portal con la capa de compatibilidad insertada al principio del <head>
(cd "$PORTAL" && node build.mjs >/dev/null)
PORTAL="$PORTAL" SALIDA="$O/assets/www/index.html" SHIM="$P/shim.js" python3 - <<'PY'
import os
src = open(os.environ["PORTAL"] + "/dist/portal-meshtastic.html", encoding="utf-8").read()
shim = open(os.environ["SHIM"], encoding="utf-8").read().replace("</script", "<\\/script")
assert "<head>" in src
html = src.replace("<head>", "<head><script>" + shim + "</script>", 1)
open(os.environ["SALIDA"], "w", encoding="utf-8").write(html)
print("portal:", len(html) // 1024, "KB")
PY

# 2) recursos y manifiesto
$T/bin/aapt2_64 compile --dir $P/res -o $O/res.zip
$T/bin/aapt2_64 link -o $O/base.apk -I $T/android-34.jar --manifest $P/AndroidManifest.xml \
  -A $O/assets --java $O/gen --min-sdk-version 24 --target-sdk-version 34 $O/res.zip

# 3) código Java → dex
javac -nowarn -Xlint:none -source 8 -target 8 -bootclasspath $T/android-34.jar -encoding UTF-8 \
  -d $O/cls $(find $P/java $O/gen -name '*.java') 2>&1 | grep -v -E "^warning|^Note|bootstrap class path|^1 warning|options" || true
(cd $O/cls && jar cf ../classes.jar .)
java -cp "$DX_JAR" com.android.dx.command.Main --dex --min-sdk-version=24 --output=$O/classes.dex $O/classes.jar

# 4) armar, alinear y firmar
cp $O/base.apk $O/sin-firmar.apk
(cd $O && zip -q -j sin-firmar.apk classes.dex)
if [ ! -f "$LLAVERO/pariz-release.jks" ]; then
  echo "No está la clave de firma en $LLAVERO. El APK sin firmar quedó en $O/sin-firmar.apk."
  echo "Poné la clave ahí (pariz-release.jks y clave.txt) o indicá otra carpeta con LLAVERO=..."
  exit 1
fi
PW=$(cat "$LLAVERO/clave.txt")
java -jar $T/uber-apk-signer.jar -a $O/sin-firmar.apk --ks "$LLAVERO/pariz-release.jks" --ksAlias pariz \
  --ksPass "$PW" --ksKeyPass "$PW" -o $O/firmado > $O/firma.log 2>&1 || { cat $O/firma.log; exit 1; }
cp $O/firmado/*.apk $P/OPEN-SOURCE-PARIZ.apk
grep -E "signature verified|zipalign verified" $O/firma.log
ls -la $P/OPEN-SOURCE-PARIZ.apk
