package ar.pariz.guarani

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.webkit.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * Recorre SIU Guaraní con un WebView invisible (comparte las cookies con la pestaña Guaraní).
 * Debe usarse en el hilo principal.
 */
class Scraper(private val ctx: Context) {

    enum class State { OK, NEED_LOGIN, LOGIN_FAILED, CAPTCHA, OFFLINE }
    data class Page(val url: String, val title: String, val text: String)
    data class Result(val state: State, val pages: List<Page>, val discovered: List<String>, val message: String = "",
                      val menu: List<Pair<String, String>> = emptyList())

    private lateinit var wv: WebView
    @Volatile private var loading = false
    @Volatile private var lastEvent = 0L
    @Volatile private var mainError: String? = null

    companion object {
        private val EXCLUDE = Regex(
            "(logout|salir|cerrar|login|/acceso|recuperar|alta_usuario|validador_certificados|ayuda_menu|fecha_examen$|horarios_cursadas$|olvid|password|clave|cambiar_perfil|imprimir|descargar|" +
            "\\.pdf|\\.zip|\\.jpg|\\.png|mailto:|javascript:|tel:|ayuda|manual|tutorial|faq|baja|eliminar|confirmar|" +
            "cambiar_carrera|seleccionar_propuesta)", RegexOption.IGNORE_CASE
        )
        /** Rutas típicas de SIU Guaraní 3 autogestión, por si el menú no expone enlaces directos. */
        val FALLBACK = listOf(
            "historia_academica", "plan_estudio", "cursada", "inscripcion_cursada", "examen", "inscripcion_examen",
            "inscripciones", "mis_inscripciones", "mensajes", "encuestas", "actuacion_provisoria",
            "reporte_actas", "calendario", "certificados", "datos_censales", "perfil"
        )
        const val MAX_PAGES = 30

        private const val EXTRACT = """
(function(){
  var pw=document.querySelector('input[type=password]');
  var main=document.querySelector('#kernel_contenido')||document.querySelector('#contenido')||document.querySelector('main')||document.querySelector('.contenido')||document.body;
  var links=[];
  document.querySelectorAll('a[href]').forEach(function(a){ links.push([a.href,(a.innerText||a.title||'').trim().slice(0,80)]); });
  var menu=[]; document.querySelectorAll('li.js-menuitem-root a, .navbar .nav a, .dropdown-menu a').forEach(function(a){
    var t=(a.innerText||'').trim(); if(t && a.href && a.href.slice(-1)!=='#') menu.push([t,a.href]); });
  var cap=!!document.querySelector('img[src*=captcha i],input[name*=captcha i],.g-recaptcha,iframe[src*=recaptcha]');
  var err=(document.querySelector('.alert-error,.alert-danger,.error,.mensaje_error')||{}).innerText||'';
  return JSON.stringify({url:location.href,title:document.title,login:!!(pw&&pw.offsetParent!==null),captcha:cap,error:err,
     text:(main&&main.innerText)||'',links:links,menu:menu});
})()"""
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun build() {
        wv = WebView(ctx.applicationContext)
        with(wv.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadsImagesAutomatically = false
            blockNetworkImage = true
            userAgentString = userAgentString.replace("; wv", "")
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true)
        wv.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) { loading = true; lastEvent = SystemClock.elapsedRealtime() }
            override fun onPageFinished(view: WebView?, url: String?) { loading = false; lastEvent = SystemClock.elapsedRealtime() }
            override fun onReceivedError(view: WebView?, req: WebResourceRequest?, err: WebResourceError?) {
                if (req?.isForMainFrame == true) mainError = err?.description?.toString() ?: "error"
            }
        }
    }

    private suspend fun waitIdle(expectNavigation: Boolean) {
        val start = SystemClock.elapsedRealtime()
        if (expectNavigation) { loading = true }
        lastEvent = SystemClock.elapsedRealtime()
        while (true) {
            delay(400)
            val now = SystemClock.elapsedRealtime()
            val idle = now - lastEvent
            if (!loading && idle > 2200 && wv.progress >= 100) break
            if (now - start > 45_000) break
        }
    }

    private suspend fun load(url: String) {
        mainError = null
        wv.loadUrl(url)
        waitIdle(true)
    }

    private suspend fun eval(js: String): String = suspendCancellableCoroutine { cont ->
        wv.evaluateJavascript(js) { raw ->
            val s = runCatching { JSONArray("[$raw]").getString(0) }.getOrDefault("")
            if (cont.isActive) cont.resume(s)
        }
    }

    private suspend fun extract(): JSONObject = runCatching { JSONObject(eval(EXTRACT)) }.getOrDefault(JSONObject())

    private suspend fun login(user: String, pass: String): Boolean {
        val js = """
(function(u,p){
  var pw=document.querySelector('input[type=password]'); if(!pw) return 'nologin';
  var f=pw.form||document;
  var us=f.querySelector('input[name=usuario],input[name=user],input[name=username],input[name=email],input[type=email],input[type=text]');
  function set(el,v){ el.focus(); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  if(us) set(us,u); set(pw,p);
  var btn=f.querySelector('button[type=submit],input[type=submit],#login,button');
  if(btn) btn.click(); else if(pw.form) pw.form.submit();
  return 'ok';
})(${JSONObject.quote(user)},${JSONObject.quote(pass)})"""
        mainError = null
        val r = eval(js)
        if (r != "ok") return false
        delay(800)
        waitIdle(false)
        return true
    }

    suspend fun run(base: String, user: String, pass: String, watched: List<String>): Result {
        build()
        try {
            load(base)
            if (mainError != null) return Result(State.OFFLINE, emptyList(), emptyList(), mainError ?: "")
            var home = extract()
            if (home.optBoolean("login")) {
                if (user.isEmpty() || pass.isEmpty()) return Result(State.NEED_LOGIN, emptyList(), emptyList())
                if (home.optBoolean("captcha")) return Result(State.CAPTCHA, emptyList(), emptyList())
                login(user, pass)
                home = extract()
                if (home.optBoolean("login")) {
                    val st = if (home.optBoolean("captcha")) State.CAPTCHA else State.LOGIN_FAILED
                    return Result(st, emptyList(), emptyList(), home.optString("error"))
                }
                // Tras el login Guaraní suele dejarnos en la portada; la volvemos a cargar para leer el menú completo.
                if (!sameDoc(home.optString("url"), base)) { load(base); home = extract() }
            }
            val homeUrl = clean(home.optString("url", base))
            val pages = mutableListOf(Page(homeUrl, home.optString("title", "Inicio"), home.optString("text")))

            val baseUri = Uri.parse(base)
            val discovered = linkedSetOf<String>()
            val links = home.optJSONArray("links") ?: JSONArray()
            for (i in 0 until links.length()) {
                val href = clean(links.optJSONArray(i)?.optString(0) ?: continue)
                if (isInternal(href, baseUri) && !EXCLUDE.containsMatchIn(href) && !sameDoc(href, homeUrl)) discovered.add(href)
            }
            if (discovered.size < 3) FALLBACK.forEach { discovered.add(base + it) }

            val toVisit = (watched + discovered).map { clean(it) }.distinct().filterNot { sameDoc(it, homeUrl) }.take(MAX_PAGES)
            val good = mutableListOf<String>()
            for (u in toVisit) {
                load(u)
                if (mainError != null) continue
                val d = extract()
                if (d.optBoolean("login")) {
                    // La sesión venció a mitad de camino: reintenta una vez con las credenciales.
                    if (user.isEmpty() || !login(user, pass)) return Result(State.NEED_LOGIN, pages, good)
                    load(u)
                }
                val e = extract()
                val finalUrl = clean(e.optString("url", u))
                // Si una ruta de respaldo redirige a la portada, no existe en este Guaraní.
                if (sameDoc(finalUrl, homeUrl) && u !in watched) continue
                if (pages.any { sameDoc(it.url, finalUrl) }) continue
                val text = e.optString("text")
                if (text.isBlank()) continue
                pages.add(Page(finalUrl, e.optString("title", u), text))
                good.add(finalUrl)
            }
            val menu = mutableListOf<Pair<String, String>>()
            val mj = home.optJSONArray("menu") ?: JSONArray()
            for (i in 0 until mj.length()) mj.optJSONArray(i)?.let { menu.add(it.optString(0) to clean(it.optString(1))) }
            return Result(State.OK, pages, good, menu = menu.distinctBy { it.second })
        } finally {
            runCatching { wv.stopLoading(); wv.destroy() }
            CookieManager.getInstance().flush()
        }
    }

    private fun clean(u: String) = u.substringBefore('#').trim()
    private fun sameDoc(a: String, b: String) = a.trimEnd('/').equals(b.trimEnd('/'), ignoreCase = true)
    private fun isInternal(href: String, base: Uri): Boolean {
        val u = Uri.parse(href)
        if (u.scheme != "http" && u.scheme != "https") return false
        if (!u.host.equals(base.host, true)) return false
        val bp = base.path ?: "/"
        return (u.path ?: "/").startsWith(bp.trimEnd('/'))
    }
}
