package ru.priceaggregator;

import android.app.Activity;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Транспорт «страница-читалка» для Пятёрки на Android (Фаза 7в).
 *
 * Пятёрка режет нативный HTTP WAF'ом (Измерение 5, .agent/gecko/evidence.md):
 * с браузерными куками 403, а XHR из страницы — CORS. Единственный не
 * опровергнутый путь — открыть адрес как страницу: WebView сам делает
 * навигацию в настоящем браузерном контексте, без подмены UA и отпечатка,
 * а тело мы читаем из DOM опросом. Поллинг нужен вместо доверия
 * onPageFinished: на WAF-страницах он не приходил за ~2 минуты (замер п.4).
 *
 * Все вызовы идут через очередь: CookieManager у WebView приложения один
 * на всех, и параллельные открытия — это гонки и лишний rate-limit. Пауза
 * между открытиями страниц (от старта к старту) — ещё и ToS-рамка Фазы 7в.
 */
@CapacitorPlugin(name = "PageReader")
public class PageReaderPlugin extends Plugin {

  /** Бюджет одной страницы: сайт мог пройти два WAF-челленджа подряд. */
  private static final long PAGE_BUDGET_MS = 90000L;
  /** Опрос DOM не ходит в сеть — чем чаще, тем точнее момент доставки. */
  private static final long PAGE_POLL_MS = 2000L;
  private static final long WARMUP_BUDGET_MS = 120000L;
  /** Бюджет ожидания ответа POST/GET после инъекции в-page скрипта. */
  private static final long POST_BUDGET_MS = 30000L;
  /** Реальные страницы Перекрёстка/Чижика — сотни тысяч символов, заглушки
   * антиботов — сотни. Ниже порога «страницей» оседать нельзя. */
  private static final long PAGE_MIN_LEN = 10000L;
  /** ToS: открытие страницы не чаще раза в 2 с, от старта к старту. */
  private static final long OPEN_GAP_MS = 2000L;
  /** Страховка очереди: колбэк evaluateJavascript мог не прийти вообще
   * (смерть рендерера WebView) — без неё поллер не оседал бы никогда и
   * опрос замолкал бы до перезапуска приложения. */
  private static final long WATCHDOG_MS = WARMUP_BUDGET_MS + 45000L;

  /** Хосты, которые читалке разрешено открывать и в пределах которых ей
   * разрешено оставаться при навигациях страницы (редиректы, JS-переходы).
   * Renderer может дозваться до плагина напрямую (window.Capacitor), поэтому
   * граница последней инстанции держится и здесь, в дополнение к проверкам
   * адаптера; новая сеть подключается к читалке вместе со своим хостом. */
  private static final String[] ALLOWED_HOSTS = { "5ka.ru", "5d.5ka.ru", "app.chizhik.club", "www.perekrestok.ru" };

  /** Полный текст тела: отдаётся только при complete, иначе poll гонял бы
   * большие строки зря. Поле text пустое, пока документ не дошёл. Результат —
   * ОБЪЕКТ, не JSON.stringify: evaluateJavascript кодирует результат как
   * JSON, и строка-результат пришла бы в Java с внешними кавычками и
   * экранированными внутренними — parseJsValue отдал бы Java-строку вместо
   * JSONObject. */
  private static final String BODY_JS =
      "(function(){var t='';try{var b=document.body;t=b?(b.textContent||''):''}catch(e){t=''}"
          + "var r=document.readyState;return {ready:r,len:t.length,text:r==='complete'?t:''}})()";

  private static final String READY_JS =
      "(function(){var t='';try{var b=document.body;t=b?(b.textContent||''):''}catch(e){t=''}"
          + "return {ready:document.readyState,len:t.length,sample:t.substring(0,300)}})()";

  /** Глушение медиа на странице читалки. Элементы mut'ятся и ставятся на
   * паузу, а слушатели 'play'/'volumechange' (capture) добирают появившихся
   * позже — динамически вставленные video/audio и программный play().
   * Инъекция идёт на каждый старт и финиш навигации: челлендж перезагружает
   * документ, и слушатели умирают вместе с ним. Глобальный mute окна
   * (AudioManager) не используется — он трогал бы звук всего телефона.
   * Ограничения (косметика, читалка ходит по JSON-страницам сетей): media
   * внутри iframe скрипт не достаёт (границы фреймов для JS непроницаемы),
   * и в окне между коммитом навигации и onPageFinished слушатели мертвы. */
  private static final String MUTE_JS =
      "(function(){var m=function(e){try{e.muted=true;e.pause()}catch(_){}}"
          + "var s=function(){var l=document.querySelectorAll('video,audio');"
          + "for(var i=0;i<l.length;i++)m(l[i])};s();"
          + "document.addEventListener('play',function(ev){m(ev.target)},true);"
          + "document.addEventListener('volumechange',function(ev){m(ev.target)},true);})()";

  /** Результат in-page POST/GET (Фаза 7г): флаг window.__paPost заполняет
   * самый скрипт (fin), Java забирает объект, пока done не установлен —
   * поллит. href нужен адаптерам, сверяющим адрес страницы после ответа. */
  private static final String POST_RESULT_JS =
      "(function(){var p=(typeof window.__paPost==='object'&&window.__paPost!==null)?window.__paPost:{};"
          + "return {done:p.done===true,status:p.status|0,"
          + "body:String(p.body==null?'':p.body),href:String(p.href==null?'':p.href)}})()";

  private final Handler main = new Handler(Looper.getMainLooper());
  private final Deque<Runnable> jobs = new ArrayDeque<>();
  private boolean draining = false;
  private long lastOpenAt = 0L;

  /** Текущее чтение: до одного WebView и одного call в полёте (очередь
   * сериализует); state всё время трогается только с main-потока, кроме
   * добавления джобов в enqueue. */
  private WebView activeView = null;
  private PluginCall activeCall = null;
  private Runnable activeWatchdog = null;
  private final AtomicBoolean activeSettled = new AtomicBoolean(true);

  /** Дешёвая проверка моста без страницы. Штатный UA — по нему evidence
   * сверяет, что замер и прод идут без подмены. */
  @PluginMethod
  public void probe(PluginCall call) {
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("мост не жив: activity нет");
      return;
    }
    JSObject out = new JSObject();
    out.put("version", WebSettings.getDefaultUserAgent(activity));
    call.resolve(out);
  }

  /** Куки контекста WebView по адресу: диагностика WAF-челленджа. Отладочная
   * сборка: прод-код не читает куки (адаптеру нужен только текст тела), а
   * открытый из renderer-слоя доступ к кукам держать незачем. */
  @PluginMethod
  public void readCookies(PluginCall call) {
    Activity activity = getActivity();
    boolean debug =
        activity != null
            && (activity.getApplicationInfo().flags
                    & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)
                != 0;
    if (!debug) {
      call.unavailable("readCookies — только отладочная сборка");
      return;
    }
    final String url = requireUrl(call);
    if (url == null) return;
    JSObject out = new JSObject();
    final String cookie = CookieManager.getInstance().getCookie(url);
    // Кук нет — пустой объект, а не строка "null": пустота обязана
    // отличаться от настоящей куки-строки и у потребителя.
    if (cookie != null) out.put("cookie", cookie);
    call.resolve(out);
  }

  /** Текст тела страницы (адреса API отдают JSON одним элементом body). */
  @PluginMethod
  public void readPage(PluginCall call) {
    final String url = requireUrl(call);
    if (url == null) return;
    enqueue(
        call,
        () ->
            startPoll(
                call,
                url,
                view -> pollBody(call, System.currentTimeMillis(), view, "")));
  }

  /** `#__NEXT_DATA__` и найденный в нём товар (обход живёт в JS на странице,
   * чтобы не перечитывать снимок тысячу раз через мост). В скрипт подставляются
   * только цифры plu — строкового кода там появиться не может. */
  @PluginMethod
  public void readNextData(PluginCall call) {
    final String url = requireUrl(call);
    if (url == null) return;
    String raw = call.getString("plu");
    final String plu = (raw == null ? "" : raw).replaceAll("\\D", "");
    if (plu.isEmpty()) {
      call.reject("plu обязателен и должен быть числом");
      return;
    }
    enqueue(
        call,
        () ->
            startPoll(
                call,
                url,
                view -> pollNextData(call, plu, System.currentTimeMillis(), view)));
  }

  /** Навигация «прогрев»: состояние антибота ставит сама страница. */
  @PluginMethod
  public void warmup(PluginCall call) {
    final String url = requireUrl(call);
    if (url == null) return;
    enqueue(
        call,
        () ->
            startPoll(
                call,
                url,
                view -> pollWarmup(call, System.currentTimeMillis(), view)));
  }

  /** POST (или GET при httpMethod=GET) из контекста страницы-донора,
   * Фаза 7г. Страница оседает только при пороге PAGE_MIN_LEN (заглушки антибота меньше),
   * затем в-page скрипт сам читает креды (кука session → JSON accessToken,
   * localStorage _SPUID) и посылает подписанный fetch на apiUrl ТОГО ЖЕ
   * происхождения; ответ несёт window-флаг — evaluateJavascript на этом
   * WebView не дожидается Promise. Токен не покидает плагин: Java его не
   * читает и не печатает. */
  @PluginMethod
  public void post(PluginCall call) {
    final String pageUrl = call.getString("pageUrl");
    if (!isAllowedUrl(pageUrl)) {
      call.reject("адрес не входит в разрешённые сети читалки");
      return;
    }
    final String apiUrl = call.getString("apiUrl");
    if (apiUrl == null || !apiUrl.startsWith("https://")) {
      call.reject("apiUrl обязателен и должен быть https");
      return;
    }
    final String pageHost = Uri.parse(pageUrl).getHost();
    final String apiHost = Uri.parse(apiUrl).getHost();
    if (pageHost == null || apiHost == null || !pageHost.equalsIgnoreCase(apiHost)) {
      call.reject("apiUrl должен быть same-origin с pageUrl — иначе разрешённый pageUrl трамплин");
      return;
    }
    final String requested = call.getString("httpMethod");
    final String httpMethod = requested == null || requested.isEmpty() ? "POST" : requested;
    if (!httpMethod.equals("POST") && !httpMethod.equals("GET")) {
      call.reject("httpMethod понимает только POST и GET");
      return;
    }
    final String bodyJson = call.getString("bodyJson");
    if (httpMethod.equals("POST") && (bodyJson == null || bodyJson.isEmpty())) {
      call.reject("для POST обязателен bodyJson");
      return;
    }
    enqueue(
        call,
        () ->
            startPoll(
                call,
                pageUrl,
                view ->
                    pollPostPage(
                        call, bodyJson, httpMethod, apiUrl, System.currentTimeMillis(), view)));
  }

  /** Страница-донор оседает только длинной настоящей страницей. */
  private void pollPostPage(
      final PluginCall call,
      final String bodyJson,
      final String httpMethod,
      final String apiUrl,
      final long begin,
      final WebView view) {
    view.evaluateJavascript(
        READY_JS,
        value -> {
          try {
            JSONObject obj = parseJsValue(value);
            boolean settled =
                "complete".equals(obj.optString("ready"))
                    && obj.optInt("len") >= PAGE_MIN_LEN
                    && !wafStub(obj.optString("sample"));
            if (settled) {
              injectPost(call, bodyJson, httpMethod, apiUrl, view);
              return;
            }
            if (System.currentTimeMillis() - begin < PAGE_BUDGET_MS) {
              main.postDelayed(
                  () -> pollPostPage(call, bodyJson, httpMethod, apiUrl, begin, view),
                  PAGE_POLL_MS);
              return;
            }
            failCurrent(
                call,
                view,
                "страница-донор не осела за " + PAGE_BUDGET_MS / 1000
                    + "с — заглушка антибота или приглашение челленджа");
          } catch (Exception e) {
            if (System.currentTimeMillis() - begin >= PAGE_BUDGET_MS) {
              failCurrent(
                  call,
                  view,
                  "страницу-донор не удалось прочитать: " + e.getClass().getSimpleName());
              return;
            }
            main.postDelayed(
                () -> pollPostPage(call, bodyJson, httpMethod, apiUrl, begin, view),
                PAGE_POLL_MS);
          }
        });
  }

  /** Инъекция выполняется РОВНО один раз: каждая инъекция — это полноценный
   * запрос к сети; ToS «≤2 попытки на адрес» держит транспорт, а не плагин. */
  private void injectPost(
      final PluginCall call,
      final String bodyJson,
      final String httpMethod,
      final String apiUrl,
      final WebView view) {
    try {
      view.evaluateJavascript(
          postJs(httpMethod, apiUrl, bodyJson),
          value -> pollPostResult(call, System.currentTimeMillis(), view));
    } catch (RuntimeException e) {
      failCurrent(call, view, "инъекция POST не удалась: " + e.getClass().getSimpleName());
    }
  }

  private void pollPostResult(
      final PluginCall call, final long begin, final WebView view) {
    view.evaluateJavascript(
        POST_RESULT_JS,
        value -> {
          try {
            JSONObject obj = parseJsValue(value);
            if (obj.optBoolean("done")) {
              if (view != activeView) return;
              if (!activeSettled.compareAndSet(false, true)) return;
              final JSObject out = new JSObject();
              out.put("status", obj.optInt("status"));
              out.put("body", obj.optString("body"));
              out.put("href", obj.optString("href"));
              completeCurrent();
              detach(view);
              view.destroy();
              call.resolve(out);
              jobDone();
              return;
            }
            if (System.currentTimeMillis() - begin < POST_BUDGET_MS) {
              main.postDelayed(() -> pollPostResult(call, begin, view), PAGE_POLL_MS);
              return;
            }
            failCurrent(
                call,
                view,
                "post не дождался ответа за " + POST_BUDGET_MS / 1000
                    + "с — страница потерялась или fetch висит");
          } catch (Exception e) {
            if (System.currentTimeMillis() - begin >= POST_BUDGET_MS) {
              failCurrent(
                  call,
                  view,
                  "результат post не читается: " + e.getClass().getSimpleName());
              return;
            }
            main.postDelayed(() -> pollPostResult(call, begin, view), PAGE_POLL_MS);
          }
        });
  }

  /**
   * В-page скрипт POST/GET. Креды читает сама страница (кука session → JSON
   * accessToken, localStorage _SPUID); пустой токен — заголовок auth не
   * ставится (Чижик живёт без auth), пустой _SPUID — без x-device-id.
   * bodyJson — уже сериализованный JSON-литерал из адаптера; ошибка fetch
   * превращается в status=0 с причиной в теле (не маскируется под пустоту).
   */
  private String postJs(final String httpMethod, final String apiUrl, final String bodyJson) {
    return "(function(){" +
        "var tk='';" +
        "var m=document.cookie.match(/(?:^|;\\s*)session=([^;]*)/);" +
        "if(m){try{var j=JSON.parse(decodeURIComponent(m[1]));" +
        "if(j&&typeof j.accessToken==='string')tk=j.accessToken}catch(e){}}" +
        "var dv='';try{dv=localStorage.getItem('_SPUID')||''}catch(e){}" +
        "var h={'content-type':'application/json',accept:'application/json'};" +
        "if(tk!=='')h.auth='Bearer '+tk;" +
        "if(dv!=='')h['x-device-id']=dv;" +
        "window.__paPost={done:false,status:0,body:'',href:''};" +
        "var fin=function(s,b){window.__paPost={done:true,status:s|0," +
        "body:String(b==null?'':b).substring(0,250000),href:location.href}};" +
        "fetch('" + apiUrl + "',{method:'" + httpMethod + "',headers:h,credentials:'include'," +
        (httpMethod.equals("GET") ? "" : "body:(" + bodyJson + "),") +
        "signal:AbortSignal.timeout(30000)})" +
        ".then(function(r){r.text().then(function(t){fin(r.status,t)}," +
        "function(e){fin(r.status,'')});}," +
        "function(e){fin(0,'<<fetch не удался: '+String(e).substring(0,200)+'>>')});" +
        "})()";
  }

  /** Создать WebView, открыть адрес и запустить полл. Синхронный выброс
   * (loadUrl/стартовая оценка) обязан снять view: иначе прикреплённый
   * невидимый слой накапливался бы при повторных отказах. */
  private void startPoll(PluginCall call, String url, Consumer<WebView> poll) {
    final WebView view = freshView();
    activeView = view;
    activeCall = call;
    activeSettled.set(false);
    try {
      view.loadUrl(url);
      poll.accept(view);
      armWatchdog(view, call);
    } catch (RuntimeException e) {
      completeCurrent();
      detach(view);
      view.destroy();
      throw e;
    }
  }

  private void pollBody(
      final PluginCall call, final long begin, final WebView view, final String lastText) {
    view.evaluateJavascript(
        BODY_JS,
        value -> {
          try {
            JSONObject obj = parseJsValue(value);
            String ready = obj.optString("ready");
            String text = obj.optString("text");
            int len = obj.optInt("len");
            // text приходит только на complete: до него «лучший» текст —
            // накопленный, иначе пустота затёрла бы уже прочитанное.
            String best = text.length() > 0 ? text : lastText;
            // complete без тела — это про navigation: первый evaluateJavascript
            // может исполниться на about:blank до старта загрузки, и оседать
            // на нём нельзя. WAF-заглушка тоже не ответ: поллить до бюджета.
            // Ответы сети (JSON) всегда непусты и не заглушка; по истечении
            // бюджета уезжает лучший прочитанный текст.
            if ("complete".equals(ready) && len > 0 && !wafStub(best)) {
              settleBody(call, view, best);
              return;
            }
            if (System.currentTimeMillis() - begin < PAGE_BUDGET_MS) {
              main.postDelayed(() -> pollBody(call, begin, view, best), PAGE_POLL_MS);
              return;
            }
            settleBody(call, view, best);
          } catch (Exception e) {
            // Разовое исключение моста — не повод срываться с полла: бюджет
            // остался, докручиваем. Оседание только по исчерпании бюджета.
            if (System.currentTimeMillis() - begin < PAGE_BUDGET_MS) {
              main.postDelayed(() -> pollBody(call, begin, view, lastText), PAGE_POLL_MS);
              return;
            }
            settleBody(call, view, lastText);
          }
        });
  }

  private void pollNextData(
      final PluginCall call, final String plu, final long begin, final WebView view) {
    view.evaluateJavascript(
        nextDataJs(plu),
        value -> {
          try {
            String envelope = value == null ? "" : (String) new JSONTokener(value).nextValue();
            if (!envelope.isEmpty()) {
              JSONObject info = new JSONObject(envelope);
              if (info.optBoolean("ok")) {
                settleEnvelope(call, view, envelope);
                return;
              }
            }
            if (System.currentTimeMillis() - begin < PAGE_BUDGET_MS) {
              main.postDelayed(() -> pollNextData(call, plu, begin, view), PAGE_POLL_MS);
              return;
            }
            String finalEnvelope =
                envelope.isEmpty()
                    ? "{\"ok\":false,\"reason\":\"next-missing\",\"codes\":[]}"
                    : envelope;
            settleEnvelope(call, view, finalEnvelope);
          } catch (Exception e) {
            if (System.currentTimeMillis() - begin < PAGE_BUDGET_MS) {
              main.postDelayed(() -> pollNextData(call, plu, begin, view), PAGE_POLL_MS);
              return;
            }
            // Бюджет кончился на битых ответах моста: честный next-missing.
            settleEnvelope(call, view, "{\"ok\":false,\"reason\":\"next-missing\",\"codes\":[]}");
          }
        });
  }

  private void pollWarmup(final PluginCall call, final long begin, final WebView view) {
    view.evaluateJavascript(
        READY_JS,
        value -> {
          try {
            JSONObject obj = parseJsValue(value);
            boolean stub = wafStub(obj.optString("sample"));
            boolean ready =
                "complete".equals(obj.optString("ready"))
                    && obj.optInt("len") > 0
                    && !stub;
            if (ready || System.currentTimeMillis() - begin >= WARMUP_BUDGET_MS) {
              settleCurrent(call, view, new JSObject());
              return;
            }
            main.postDelayed(() -> pollWarmup(call, begin, view), PAGE_POLL_MS);
          } catch (Exception e) {
            if (System.currentTimeMillis() - begin < WARMUP_BUDGET_MS) {
              main.postDelayed(() -> pollWarmup(call, begin, view), PAGE_POLL_MS);
              return;
            }
            final String valueDump =
                value == null
                    ? "null"
                    : (value.length() > 80 ? value.substring(0, 80) : value);
            failCurrent(
                call,
                view,
                "прогрев не удалось прочитать: " + e.getClass().getSimpleName()
                    + " value=" + valueDump);
          }
        });
  }

  private void settleBody(final PluginCall call, final WebView view, final String text) {
    JSObject out = new JSObject();
    out.put("text", text == null ? "" : text);
    settleCurrent(call, view, out);
  }

  private void settleEnvelope(final PluginCall call, final WebView view, final String envelope) {
    JSObject out = new JSObject();
    out.put("envelope", envelope);
    settleCurrent(call, view, out);
  }

  /** Оседание текущего чтения — РОВНО один раз на job: первый дозвон
   * снимает view и завершает job, поздние колбэки (в том числе и после
   * срабатывания страховки) уходят мимо: view уже не текущий. */
  private void settleCurrent(final PluginCall call, final WebView view, final JSObject out) {
    if (view != activeView) return;
    if (!activeSettled.compareAndSet(false, true)) return;
    completeCurrent();
    detach(view);
    view.destroy();
    call.resolve(out);
    jobDone();
  }

  private void failCurrent(final PluginCall call, final WebView view, final String message) {
    if (view != activeView) return;
    if (!activeSettled.compareAndSet(false, true)) return;
    completeCurrent();
    detach(view);
    view.destroy();
    call.reject(message);
    jobDone();
  }

  /** Снять страховку и записи текущего job-а (не снимая сам view). */
  private void completeCurrent() {
    if (activeWatchdog != null) {
      main.removeCallbacks(activeWatchdog);
      activeWatchdog = null;
    }
    activeView = null;
    activeCall = null;
    activeSettled.set(true);
  }

  private void armWatchdog(final WebView view, final PluginCall call) {
    // Право сработать — только у страховки СВОЕГО job-а: при несовпадении
    // view (job уже осел, начался другой) ранний выстрел уходит мимо.
    Runnable it =
        () -> {
          if (activeView != view) return;
          if (!activeSettled.compareAndSet(false, true)) return;
          activeView = null;
          activeCall = null;
          activeWatchdog = null;
          detach(view);
          view.destroy();
          call.reject("чтение не дождалось колбэка WebView — страховка очереди");
          jobDone();
        };
    activeWatchdog = it;
    main.postDelayed(it, WATCHDOG_MS);
  }

  private WebView freshView() {
    WebView view = new WebView(getActivity());
    view.getSettings().setJavaScriptEnabled(true);
    view.getSettings().setDomStorageEnabled(true);
    view.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
    // UA не подменяем (ToS): страница выполняется штатным WebView, WAF видит
    // настоящий Chromium устройства, как у обычного посетителя.
    view.setFocusable(false);
    // Касания читалка НЕ МОЖЕТ перехватывать (clickjacking и «зависание»
    // интерфейса на время чтения): выключенные кликабельность и фокус
    // пропускают жесты сквозь — их подхватывает WebView приложения. При этом
    // disabled не мешает отрисовке и JS — челлендж продолжает тикать.
    view.setEnabled(false);
    view.setClickable(false);
    view.setLongClickable(false);
    // Анти-доступ: челлендж-движки известны probing'ом getUserMedia, и
    // невидимая читалка — не тот слой, где камера или микрофон могут быть
    // разрешены. Отказ честный: так же отвечает браузер по кнопке «запретить»,
    // без флага бота. Свой WebChromeClient здесь не ломает мост Capacitor —
    // у читалки отдельный WebView, не штатный bridge.webView.
    view.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public void onPermissionRequest(final PermissionRequest request) {
            request.deny();
          }
        });
    // Анти-шум: страница читалки не должна звучать. См. MUTE_JS.
    view.setWebViewClient(
        new WebViewClient() {
          @Override
          public void onPageStarted(WebView v, final String url, final Bitmap favicon) {
            v.evaluateJavascript(MUTE_JS, null);
          }

          @Override
          public void onPageFinished(WebView v, final String url) {
            v.evaluateJavascript(MUTE_JS, null);
          }

          @Override
          public boolean shouldOverrideUrlLoading(final WebView v, final WebResourceRequest request) {
            // Навигации читалки ограничены теми же сетями, что и открытия:
            // редирект или JS-переход страницы не уводит невидимый WebView на
            // чужой домен (граница последней инстанции, как у requireUrl).
            // Подресурсы (скрипты челленджа с CDN) навигациями не являются и
            // не затронуты; входной loadUrl тоже — он проверен requireUrl.
            if (!request.isForMainFrame()) return false;
            if (isAllowedHost(request.getUrl().getHost())) return false;
            Log.w("PageReader", "читалка: навигация на чужой хост отклонена");
            return true;
          }
        });
    // Прикрепление ОБЯЗАТЕЛЬНО: отсоединённый WebView (в наши дни Android 12+)
    // не выполняет JS — evaluateJavascript отвечает null, и вся читалка
    // падала бы на «прогрев не удалось прочитать». Размер — на весь контент
    // активности с почти нулевой прозрачностью: WAF-челлендж меряет вьюпорт
    // (1x1 он отвергает), а полностью прозрачный слой браузер может не
    // рисовать. Вставка ПОВЕРХ интерфейса (последним ребёнком) принципиальна:
    // читалка под непрозрачным WebView не имеет кадров (rAF/челлендж замирал,
    // живой прогон), поверх — отрисовка идёт и challenge доходит до конца.
    Activity activity = getActivity();
    if (activity != null) {
      ViewGroup content = activity.findViewById(android.R.id.content);
      if (content instanceof ViewGroup) {
        FrameLayout.LayoutParams params =
            new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT);
        view.setLayoutParams(params);
        view.setAlpha(0.02f);
        content.addView(view, params);
      }
    }
    return view;
  }

  /** Снять view из иерархии перед destroy: иначе окно держит мёртвый WebView. */
  private void detach(WebView view) {
    if (view.getParent() instanceof ViewGroup) {
      ((ViewGroup) view.getParent()).removeView(view);
    }
  }

  private String requireUrl(PluginCall call) {
    String url = call.getString("url");
    if (isAllowedUrl(url)) return url;
    call.reject("адрес не входит в разрешённые сети читалки");
    return null;
  }

  /** Адрес обязателен, https и в allowlist. pageUrl пост-метода подъезжает
   * под своим ключом, поэтому проверка выделена отдельно. Вход строгий —
   * точное совпадение хоста: адреса входа конструируют наши адаптеры. */
  private boolean isAllowedUrl(final String url) {
    if (url == null || !url.startsWith("https://")) return false;
    String host = Uri.parse(url).getHost();
    for (String allowed : ALLOWED_HOSTS) {
      if (allowed.equalsIgnoreCase(host)) return true;
    }
    return false;
  }

  /** Хост принадлежит одной из сетей читалки: точное совпадение или поддомен
   * (суффикс с точкой). Суффикс нужен навигациям: редирект на www./m.-вариант
   * того же домена — нормальный ход сети, а чужой домен им не притворится
   * («злодейский» хост не кончается на «.5ka.ru»). */
  private boolean isAllowedHost(final String host) {
    if (host == null) return false;
    final String lower = host.toLowerCase(Locale.ROOT);
    for (String allowed : ALLOWED_HOSTS) {
      final String domain = allowed.toLowerCase(Locale.ROOT);
      if (lower.equals(domain) || lower.endsWith("." + domain)) return true;
    }
    return false;
  }

  private JSONObject parseJsValue(String value) throws Exception {
    Object parsed = new JSONTokener(value).nextValue();
    if (parsed instanceof JSONObject) return (JSONObject) parsed;
    throw new IllegalStateException("не объект JS");
  }

  /**
   * WAF-заглушка X5: тело уже есть, но это не ответ, а челлендж или отказ —
   * оседать на нём бессмысленно, полл продолжается до смены заглушки
   * настоящей страницей (челлендж перезагружает её сам) либо бюджета.
   * Маркеры — те же три, что в адаптере (`wafPage` в 5ka-page.ts,
   * pyaterochka.ts); тело JS-челленджа может не иметь НИ одного маркера —
   * тогда читалка оседает быстрее, но адаптер узнаёт WAF по HTML-началу
   * ответа и повторяет (PageFailure), так что подмена на дрейф не проходит.
   */
  private static boolean wafStub(final String text) {
    return text != null
        && (text.contains("Проблемы со связью")
            || text.contains("request id")
            || text.contains("проверьте настройки интернета и VPN")
            || text.contains("get_cookie_spsn")
            || text.contains("get_cookie_spid"));
  }

  /**
   * Обход `#__NEXT_DATA__` на странице: товар ищется по plu, коды магазина
   * собираются ВСЕ из любых узлов (включая вложенные JSON-строки store'ов).
   * product уезжает отдельной JSON-строкой — дважды сериализованный товар это
   * часть интерфейса, парсить его будет адаптер.
   */
  private String nextDataJs(String plu) {
    return "(function(){"
        + "var el=document.getElementById('__NEXT_DATA__');"
        + "if(!el||!el.textContent)return JSON.stringify({ok:false,reason:'next-missing',codes:[]});"
        + "var raw=el.textContent;var root;"
        + "try{root=JSON.parse(raw)}catch(e){return JSON.stringify({ok:false,reason:'next-broken',codes:[]})}"
        + "var found=null;var codes={};var stack=[{node:root,depth:0}];"
        + "while(stack.length>0){"
        + "var cur=stack.pop();var n=cur.node;"
        + "if(!n||typeof n!=='object'||cur.depth>12)continue;"
        + "if(Array.isArray(n)){for(var i=0;i<n.length;i++)stack.push({node:n[i],depth:cur.depth+1});continue;}"
        + "if(found===null&&n.plu!=null&&String(n.plu)==='" + plu + "')found=n;"
        + "var ks=Object.keys(n);"
        + "for(var j=0;j<ks.length;j++){"
        + "var k=ks[j];var v=n[k];"
        + "if((k==='storeId'||k==='store_id'||k==='sapCode'||k==='shopId')&&typeof v==='string'&&/^[0-9A-Za-z]{3,8}$/.test(v))codes[v]=1;"
        + "if(typeof v==='string'&&v.trimStart().charAt(0)==='{'){try{stack.push({node:JSON.parse(v),depth:cur.depth+1});continue}catch(e){}}"
        + "if(v&&typeof v==='object')stack.push({node:v,depth:cur.depth+1});"
        + "}"
        + "}"
        + "var cl=Object.keys(codes);"
        + "if(found===null)return JSON.stringify({ok:false,reason:'product-missing',codes:cl});"
        + "return JSON.stringify({ok:true,codes:cl,product:JSON.stringify(found)});"
        + "})()";
  }

  /**
   * Очередь чтений. Job сам отвечает за завершение: resolve/reject обязаны
   * дойти до jobDone, иначе очередь встала бы навсегда; поэтому каждый job
   * обёрнут так, что даже выброс в синхронной части завершает его честно.
   */
  private void enqueue(final PluginCall call, final Runnable work) {
    synchronized (jobs) {
      jobs.addLast(
          () -> {
            lastOpenAt = System.currentTimeMillis();
            if (getActivity() == null) {
              call.reject("приложение закрывается — страница не открыта");
              jobDone();
              return;
            }
            try {
              work.run();
            } catch (RuntimeException e) {
              call.reject("чтение страницы не удалось: " + e.getClass().getSimpleName());
              jobDone();
            }
          });
      if (draining) return;
      draining = true;
    }
    // Гэп считается и на опустевшей очереди: без этого две быстрые страницы
    // подряд открывались бы без паузы, обходя ToS-рамку «от старта к старту».
    long gap = Math.max(0L, OPEN_GAP_MS - (System.currentTimeMillis() - lastOpenAt));
    main.postDelayed(this::drainNext, gap);
  }

  private void drainNext() {
    Runnable next;
    synchronized (jobs) {
      next = jobs.pollFirst();
      if (next == null) {
        draining = false;
        return;
      }
    }
    next.run();
  }

  /** Пауза между открытиями страниц считается от старта предыдущего: работа
   * заняла минуты — гэпа нет, заняла 50 мс — следующая страница ждёт остаток. */
  private void jobDone() {
    long gap = Math.max(0L, OPEN_GAP_MS - (System.currentTimeMillis() - lastOpenAt));
    main.postDelayed(this::drainNext, gap);
  }
}
