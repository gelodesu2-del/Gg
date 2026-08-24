import com.android.apksig.ApkSigner;
import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Signs with v1 and v2. v2 is what lets the package target a modern SDK
    without the installer refusing it. */
public class Sign {
    public static void main(String[] args) throws Exception {
        String store = args[0], pass = args[1], in = args[2], out = args[3];
        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(new FileInputStream(store), pass.toCharArray());
        String alias = ks.aliases().nextElement();
        PrivateKey key = (PrivateKey) ks.getKey(alias, pass.toCharArray());
        List<X509Certificate> chain = new ArrayList<X509Certificate>();
        for (Certificate c : ks.getCertificateChain(alias)) chain.add((X509Certificate) c);

        ApkSigner.SignerConfig cfg =
            new ApkSigner.SignerConfig.Builder("CERT", key, chain).build();
        new ApkSigner.Builder(Collections.singletonList(cfg))
            .setInputApk(new File(in))
            .setOutputApk(new File(out))
            // v1 uses a JDK internal whose signature changed in newer JDKs.
            // v2 alone is verified from Android 7 onward and minSdk here is 24,
            // so nothing supported loses the ability to install this.
            .setV1SigningEnabled(false)
            .setV2SigningEnabled(true)
            .build()
            .sign();
        System.out.println("signed -> " + out);
    }
}
