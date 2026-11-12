package ar.pariz.guarani

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.*
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.materialswitch.MaterialSwitch

class MainActivity : AppCompatActivity() {

    private lateinit var dashWeb: WebView
    private lateinit var dashSwipe: SwipeRefreshLayout
    private lateinit var gWeb: WebView
    private lateinit var menuWeb: WebView
    private var lastAutoLogin = 0L
    private lateinit var webPane: View
    private lateinit var setPane: View
    private lateinit var nav: BottomNavigationView
    private var gLoaded = false
    private var fileCb: ValueCallback<Array<Uri>>? = null

    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        fileCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        fileCb = null
    }
    private val notifPerm = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.ensureSeed(this)
        setContentView(R.layout.activity_main)
        dashWeb = findViewById(R.id.dashWeb)
        dashSwipe = findViewById(R.id.dashSwipe)
        gWeb = findViewById(R.id.guaraniWeb)
        menuWeb = findViewById(R.id.menuWeb)
        webPane = findViewById(R.id.webPane)
        setPane = findViewById(R.id.setPane)
        nav = findViewById(R.id.nav)

        setupDashboard()
        setupGuarani()
        setupMenu()
        setupSettings()

        nav.setOnItemSelectedListener { show(it.itemId); true }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    nav.selectedItemId == R.id.nav_web && gWeb.canGoBack() -> gWeb.goBack()
                    nav.selectedItemId != R.id.nav_dash -> nav.selectedItemId = R.id.nav_dash
                    else -> finish()
                }
            }
        })

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifPerm.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        WorkManager.getInstance(this).getWorkInfosByTagLiveData(CheckWorker.TAG).observe(this) { list ->
            val running = list.any { it.state == WorkInfo.State.RUNNING }
            dashSwipe.isRefreshing = running
            refreshDashboard()
            updateStatus()
        }

        if (!Config.configured(this)) nav.selectedItemId = R.id.nav_set
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        refreshDashboard()
        updateStatus()
    }

    private fun handleIntent(i: Intent?) {
        when (i?.getStringExtra("tab")) {
            "web" -> nav.selectedItemId = R.id.nav_web
            "dash" -> nav.selectedItemId = R.id.nav_dash
            "menu" -> nav.selectedItemId = R.id.nav_menu
        }
    }

    private fun show(id: Int) {
        dashSwipe.visibility = if (id == R.id.nav_dash) View.VISIBLE else View.GONE
        menuWeb.visibility = if (id == R.id.nav_menu) View.VISIBLE else View.GONE
        if (id == R.id.nav_menu) menuWeb.evaluateJavascript("window.dash && dash.refresh()", null)
        webPane.visibility = if (id == R.id.nav_web) View.VISIBLE else View.GONE
        setPane.visibility = if (id == R.id.nav_set) View.VISIBLE else View.GONE
        if (id == R.id.nav_web && !gLoaded) { gLoaded = true; gWeb.loadUrl(Config.baseUrl(this)) }
        if (id == R.id.nav_dash) refreshDashboard()
        if (id == R.id.nav_set) loadSettingsFields()
    }

    // ---------------- Tablero ----------------
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupDashboard() {
        dashWeb.settings.javaScriptEnabled = true
        dashWeb.settings.domStorageEnabled = true
        dashWeb.addJavascriptInterface(Bridge(), "Android")
        dashWeb.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, req: WebResourceRequest?): Boolean = true
        }
        dashWeb.loadUrl("file:///android_asset/dashboard.html")
        dashSwipe.setColorSchemeColors(0xFF1F5C4A.toInt())
        dashSwipe.setOnRefreshListener { Scheduler.checkNow(this) }
        dashSwipe.setOnChildScrollUpCallback { _, _ -> dashWeb.scrollY > 0 }
    }

    private fun refreshDashboard() {
        if (::dashWeb.isInitialized) dashWeb.evaluateJavascript("window.dash && dash.refresh()", null)
        if (::menuWeb.isInitialized) menuWeb.evaluateJavascript("window.dash && dash.refresh()", null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupMenu() {
        menuWeb.settings.javaScriptEnabled = true
        menuWeb.addJavascriptInterface(Bridge(), "Android")
        menuWeb.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, req: WebResourceRequest?): Boolean = true
        }
        menuWeb.loadUrl("file:///android_asset/menu.html")
    }

    /** Abre cualquier sección de Guaraní en la pestaña Guaraní. */
    fun openInGuarani(url: String) {
        gLoaded = true
        nav.selectedItemId = R.id.nav_web
        gWeb.loadUrl(url)
    }

    /** Si Guaraní muestra el formulario de ingreso y hay usuario guardado, entra solo. */
    private fun autoLogin(view: WebView?) {
        val u = Config.user(this); val p = Config.pass(this)
        if (u.isEmpty() || p.isEmpty()) return
        val now = System.currentTimeMillis()
        if (now - lastAutoLogin < 60_000) return
        val js = """
(function(u,p){
  var pw=document.querySelector('input[type=password]'); if(!pw||pw.offsetParent===null) return 'no';
  var f=pw.form; if(!f) return 'no';
  if(document.querySelector('.alert-error,.alert-danger')) return 'error';
  var us=f.querySelector('input[name=usuario],input[type=text]'); if(us) us.value=u; pw.value=p;
  var b=f.querySelector('#login,input[type=submit],button[type=submit]'); if(b) b.click(); else f.submit();
  return 'ok';
})(${org.json.JSONObject.quote(u)},${org.json.JSONObject.quote(p)})"""
        view?.evaluateJavascript(js) { r -> if (r?.contains("ok") == true) lastAutoLogin = now }
    }

    inner class Bridge {
        @JavascriptInterface fun get(name: String): String =
            if (name in Store.DATASETS) Store.get(this@MainActivity, name) else "[]"
        @JavascriptInterface fun status(): String = Store.status(this@MainActivity)
        @JavascriptInterface fun checkNow() { runOnUiThread { Scheduler.checkNow(this@MainActivity); toast("Revisando Guaraní…") } }
        @JavascriptInterface fun openGuarani() { runOnUiThread { nav.selectedItemId = R.id.nav_web } }
        @JavascriptInterface fun base(): String = Config.baseUrl(this@MainActivity)
        @JavascriptInterface fun open(url: String) {
            val ok = url.startsWith(Config.baseUrl(this@MainActivity).trimEnd('/')) || url.startsWith("https://siu.iugna.edu.ar/")
            runOnUiThread { if (ok) openInGuarani(url) }
        }
        @JavascriptInterface fun openSettings() { runOnUiThread { nav.selectedItemId = R.id.nav_set } }
    }

    // ---------------- Guaraní completo ----------------
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupGuarani() {
        val progress = findViewById<ProgressBar>(R.id.webProgress)
        val title = findViewById<TextView>(R.id.webTitle)
        with(gWeb.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = true
            userAgentString = userAgentString.replace("; wv", "")
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(gWeb, true)
        gWeb.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) { progress.visibility = View.VISIBLE }
            override fun onPageFinished(view: WebView?, url: String?) {
                progress.visibility = View.GONE
                title.text = view?.title?.ifBlank { null } ?: "SIU Guaraní"
                CookieManager.getInstance().flush()
                view?.postDelayed({ autoLogin(view) }, 900)
            }
            override fun shouldOverrideUrlLoading(view: WebView?, req: WebResourceRequest?): Boolean {
                val u = req?.url ?: return false
                if (u.scheme == "http" || u.scheme == "https") return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
        }
        gWeb.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, p: Int) { progress.progress = p }
            override fun onShowFileChooser(w: WebView?, cb: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean {
                fileCb?.onReceiveValue(null)
                fileCb = cb
                return try { pickFile.launch(params!!.createIntent()); true } catch (e: Exception) { fileCb = null; false }
            }
        }
        gWeb.setDownloadListener { url, ua, cd, mime, _ ->
            runCatching {
                val name = URLUtil.guessFileName(url, cd, mime)
                val req = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .addRequestHeader("User-Agent", ua)
                    .setMimeType(mime)
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                getSystemService(DownloadManager::class.java).enqueue(req)
                toast("Descargando $name")
            }.onFailure { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }
        findViewById<ImageButton>(R.id.webBack).setOnClickListener { if (gWeb.canGoBack()) gWeb.goBack() }
        findViewById<ImageButton>(R.id.webHome).setOnClickListener { gWeb.loadUrl(Config.baseUrl(this)) }
        findViewById<ImageButton>(R.id.webReload).setOnClickListener { gWeb.reload() }
    }

    // ---------------- Ajustes ----------------
    private fun setupSettings() {
        val sp = findViewById<Spinner>(R.id.setInterval)
        sp.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, Config.INTERVAL_LABELS)
        loadSettingsFields()

        findViewById<Button>(R.id.btnSave).setOnClickListener {
            val url = findViewById<EditText>(R.id.setUrl).text.toString()
            val oldUrl = Config.baseUrl(this)
            Config.save(this, url, Config.INTERVALS[sp.selectedItemPosition],
                findViewById<MaterialSwitch>(R.id.setAll).isChecked, findViewById<MaterialSwitch>(R.id.setWifi).isChecked)
            val u = findViewById<EditText>(R.id.setUser).text.toString()
            val p = findViewById<EditText>(R.id.setPass).text.toString()
            if (u.isNotBlank() || p.isNotBlank()) Config.saveCreds(this, u, p)
            if (Config.baseUrl(this) != oldUrl) { gLoaded = false; Store.setWatched(this, emptyList()) }
            Scheduler.schedule(this, replace = true)
            Scheduler.checkNow(this)
            toast("Guardado. Primera revisión en marcha.")
            loadSettingsFields()
        }
        findViewById<Button>(R.id.btnCheck).setOnClickListener { Scheduler.checkNow(this); toast("Revisando Guaraní…") }
        findViewById<Button>(R.id.btnTest).setOnClickListener {
            Notifier.notify(this, Notifier.CH_NOTAS, "Prueba: nueva nota en Guaraní", "Así te va a llegar el aviso cuando carguen una nota.")
        }
        findViewById<Button>(R.id.btnBattery).setOnClickListener {
            val pm = getSystemService(PowerManager::class.java)
            if (pm.isIgnoringBatteryOptimizations(packageName)) toast("Ya está permitido.")
            else runCatching {
                @SuppressLint("BatteryLife")
                val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                startActivity(i)
            }
        }
        findViewById<Button>(R.id.btnPages).setOnClickListener {
            Store.setWatched(this, findViewById<EditText>(R.id.setPages).text.toString().lines())
            toast("Páginas guardadas")
        }
        findViewById<Button>(R.id.btnReset).setOnClickListener {
            Store.clearSnapshots(this)
            Store.setFlag(this, "baseline_done", false)
            Scheduler.checkNow(this)
            toast("Tomando una foto nueva de Guaraní")
        }
    }

    private fun loadSettingsFields() {
        findViewById<EditText>(R.id.setUrl).setText(Config.baseUrl(this))
        findViewById<EditText>(R.id.setUser).setText(Config.user(this))
        findViewById<EditText>(R.id.setPass).setText(Config.pass(this))
        findViewById<Spinner>(R.id.setInterval).setSelection(Config.INTERVALS.indexOf(Config.interval(this)).coerceAtLeast(0))
        findViewById<MaterialSwitch>(R.id.setAll).isChecked = Config.notifyAll(this)
        findViewById<MaterialSwitch>(R.id.setWifi).isChecked = Config.wifiOnly(this)
        findViewById<EditText>(R.id.setPages).setText(Store.watched(this).joinToString("\n"))
        updateStatus()
    }

    private fun updateStatus() {
        findViewById<TextView>(R.id.setStatus)?.text = "Última revisión: " + Store.status(this)
        if (::dashWeb.isInitialized) dashWeb.evaluateJavascript("window.setAppStatus && setAppStatus()", null)
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
