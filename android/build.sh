#!/usr/bin/env bash
# Builds the APK without an Android SDK.
#
# dl.google.com is unreachable from some networks, which rules out the usual
# SDK download and therefore Bubblewrap and Gradle. Everything needed is on
# Maven Central instead: aapt2 ships inside apktool-lib, dx is Jake Wharton's
# repackaging of the old dexer, and apksig handles signing.
#
# Requires only a JDK, curl, python3 and unzip.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_TOOL_OPTIONS=""

DL=.build/dl; TOOLS=.build/tools; OUT=.build/out
mkdir -p "$DL" "$TOOLS" "$OUT" .build/classes .build/compiled .build/gen .build/signer
M=https://repo1.maven.org/maven2

get() { [ -s "$2" ] || curl -sSL -m 600 -o "$2" "$1"; }

echo "> fetching tools"
APKTOOL=$(curl -sSL "$M/org/apktool/apktool-lib/maven-metadata.xml" | grep -oE '<release>[^<]+' | sed 's/<release>//')
get "$M/org/apktool/apktool-lib/$APKTOOL/apktool-lib-$APKTOOL.jar" "$DL/apktool-lib.jar"
get "$M/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar" "$DL/dx.jar"
get "$M/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar" "$DL/apksig.jar"
# Robolectric's android-all doubles as a compile-time framework classpath.
get "$M/org/robolectric/android-all/14-robolectric-10818077/android-all-14-robolectric-10818077.jar" "$DL/android.jar"
unzip -o -j "$DL/apktool-lib.jar" 'prebuilt/linux/aapt2' -d "$TOOLS" >/dev/null
unzip -o -j "$DL/apktool-lib.jar" 'prebuilt/android-framework.jar' -d "$TOOLS" >/dev/null
chmod +x "$TOOLS/aapt2"

echo "> resources"
"$TOOLS/aapt2" compile --dir res -o .build/compiled/res.zip
"$TOOLS/aapt2" link -o "$OUT/base.apk" -I "$TOOLS/android-framework.jar" \
  --manifest AndroidManifest.xml --java .build/gen \
  --min-sdk-version 24 --target-sdk-version 33 .build/compiled/res.zip

echo "> java -> dex"
# dx cannot read class files newer than Java 8, and cannot desugar lambdas,
# so the source deliberately avoids them.
javac --release 8 -nowarn -classpath "$DL/android.jar" -d .build/classes \
  $(find src .build/gen -name '*.java')
java -cp "$DL/dx.jar" com.android.dx.command.Main --dex --min-sdk-version=24 \
  --output="$OUT/classes.dex" .build/classes

echo "> assemble + align"
python3 align.py "$OUT/base.apk" "$OUT/classes.dex" "$OUT/unsigned.apk"

echo "> sign"
[ -f "$OUT/dash.p12" ] || keytool -genkeypair -keystore "$OUT/dash.p12" -storetype PKCS12 \
  -storepass nmaxdash -keypass nmaxdash -alias nmax -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=NMAX Dash, OU=Personal, O=NMAX Dash, L=Manila, C=PH"
javac -nowarn -cp "$DL/apksig.jar" -d .build/signer signer/Sign.java
# apksig 2.3.0 predates the module system and reaches into java.base.
java --add-exports java.base/sun.security.x509=ALL-UNNAMED \
  -cp "$DL/apksig.jar:.build/signer" Sign "$OUT/dash.p12" nmaxdash "$OUT/unsigned.apk" nmax-dash.apk

"$TOOLS/aapt2" dump badging nmax-dash.apk | head -3
echo "> built nmax-dash.apk"
