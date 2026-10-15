/**
 * Smart Trader EGX v12.0 — Cloudflare Worker
 * يدعم: /api/quote (بيانات Stooq) + الصفحة الرئيسية
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ===== API: جلب بيانات السهم من Stooq =====
    if (url.pathname === '/api/quote' || url.pathname === '/') {
      const symbol = (url.searchParams.get('symbol') || 'COMI').toUpperCase();
      const range = url.searchParams.get('range') || '6mo';

      // إذا كان الطلب من المتصفح مباشرة (بدون symbol)، نعرض معلومات
      if (!url.searchParams.get('symbol') && url.pathname === '/') {
        return jsonResp({
          ok: true,
          message: '✅ Worker يعمل — أرسل symbol للحصول على البيانات',
          example: '/api/quote?symbol=COMI&range=6mo',
          time: new Date().toISOString()
        }, 200, cors);
      }

      // جلب من Stooq
      try {
        const stqUrl = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.eg&i=d`;
        const res = await fetch(stqUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          cf: { cacheTtl: 300, cacheEverything: true },
        });

        if (!res.ok) {
          return jsonResp({ ok: false, error: 'Stooq HTTP ' + res.status }, 502, cors);
        }

        const text = await res.text();
        if (!text || text.length < 50 || text.toLowerCase().includes('exceeded')) {
          return jsonResp({ ok: false, error: 'Stooq: لا توجد بيانات للرمز ' + symbol }, 404, cors);
        }

        const lines = text.trim().split('\n').filter(l => l.trim());
        if (lines.length < 31) {
          return jsonResp({ ok: false, error: 'Stooq: شمعات غير كافية (' + lines.length + ')' }, 404, cors);
        }

        // تحليل CSV
        const bars = [];
        for (let i = 1; i < lines.length; i++) {
          const p = lines[i].split(',');
          if (p.length < 6) continue;
          const date = p[0].trim();
          const o = +p[1], h = +p[2], l = +p[3], c = +p[4], v = +p[5];
          if ([o, h, l, c, v].every(Number.isFinite) && c > 0 && date) {
            bars.push({
              date,
              open: o, high: h, low: l, close: c, volume: v
            });
          }
        }

        if (bars.length < 30) {
          return jsonResp({ ok: false, error: 'شمعات صالحة غير كافية' }, 404, cors);
        }

        // إزالة التكرار والترتيب
        const unique = [...new Map(bars.map(b => [b.date, b])).values()]
          .sort((a, b) => a.date.localeCompare(b.date));

        // حساب المؤشرات
        const closes = unique.map(b => b.close);
        const vols = unique.map(b => b.volume);
        const ma20 = closes.length >= 20
          ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20
          : null;
        const ma50 = closes.length >= 50
          ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50
          : null;

        // RSI (14)
        let rsiVal = null;
        if (closes.length >= 15) {
          const changes = [];
          for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
          let g = 0, l = 0;
          for (let i = 0; i < 14; i++) {
            g += Math.max(changes[i], 0);
            l += Math.max(-changes[i], 0);
          }
          g /= 14; l /= 14;
          for (let i = 14; i < changes.length; i++) {
            g = (g * 13 + Math.max(changes[i], 0)) / 14;
            l = (l * 13 + Math.max(-changes[i], 0)) / 14;
          }
          rsiVal = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
        }

        // الحجم النسبي
        let relVol = null;
        if (vols.length >= 21) {
          const base = vols.slice(-21, -1);
          const avg = base.reduce((a, b) => a + b, 0) / 20;
          relVol = avg > 0 ? vols[vols.length - 1] / avg : null;
        }

        const last = unique[unique.length - 1];
        const price = last.close;

        // اتخاذ قرار
        let signal = 'انتظار';
        let score = 0;
        const reasons = [];

        if (ma20 && ma50) {
          if (price > ma20 && ma20 > ma50) { score++; reasons.push('اتجاه صاعد'); }
          else if (price < ma20 && ma20 < ma50) { reasons.push('اتجاه هابط'); }
          else { reasons.push('اتجاه غير مكتمل'); }
        }

        if (rsiVal !== null) {
          if (rsiVal >= 40 && rsiVal <= 70) { score++; reasons.push('RSI ضمن النطاق'); }
          else reasons.push('RSI خارج النطاق');
        }

        if (relVol !== null) {
          if (relVol >= 1) { score++; reasons.push('حجم داعم'); }
          else reasons.push('الحجم غير داعم');
        }

        if (reasons.some(r => r.includes('هابط'))) signal = 'إشارة ضعف/بيع';
        else if (score === 3) signal = 'شراء محتمل';
        else if (score === 2) signal = 'مراقبة';
        else signal = 'انتظار';

        return jsonResp({
          ok: true,
          symbol,
          range,
          price: +price.toFixed(3),
          ma20: ma20 ? +ma20.toFixed(3) : null,
          ma50: ma50 ? +ma50.toFixed(3) : null,
          rsi: rsiVal ? +rsiVal.toFixed(2) : null,
          relVolume: relVol ? +relVol.toFixed(2) : null,
          lastDate: last.date,
          bars: unique.length,
          signal,
          score: score + '/3',
          reasons: reasons.join(' · '),
          source: 'Stooq',
          timestamp: new Date().toISOString()
        }, 200, cors);

      } catch (err) {
        return jsonResp({
          ok: false,
          error: 'خطأ في الجلب: ' + (err.message || String(err))
        }, 500, cors);
      }
    }

    // ===== الصفحة الرئيسية (عند فتح الرابط مباشرة) =====
    return new Response(HTML_PAGE, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

function jsonResp(data, status, cors) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

// ===== الصفحة الرئيسية HTML =====
const HTML_PAGE = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smart Trader EGX v12.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f172a;color:#f8fafc;font-family:system-ui,Tahoma,Arial;padding:16px;line-height:1.6}
.wrap{max-width:520px;margin:auto}
.head{text-align:center;padding:14px;background:#1e293b;border-radius:12px;border:1px solid #334155;margin-bottom:14px}
.head h1{font-size:1.3rem;color:#38bdf8;margin-bottom:4px}
.head p{font-size:.85rem;color:#94a3b8}
.card{background:#1e293b;padding:16px;border-radius:12px;border:1px solid #334155;margin-bottom:14px}
label{font-size:.85rem;color:#94a3b8;display:block;margin-bottom:6px}
select,button{width:100%;padding:11px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#f8fafc;font-size:.95rem;font-family:inherit}
button{background:#38bdf8;color:#0f172a;font-weight:700;cursor:pointer;border:none;margin-top:10px}
button:hover{filter:brightness(1.1)}
button:disabled{opacity:.5;cursor:not-allowed}
.badge{display:inline-block;padding:4px 10px;border-radius:6px;font-size:.75rem;background:#334155;color:#94a3b8}
.badge.ok{background:rgba(34,197,94,.2);color:#22c55e}
.badge.err{background:rgba(239,68,68,.2);color:#ef4444}
.badge.load{background:rgba(56,189,248,.2);color:#38bdf8}
.metric{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #334155;font-size:.9rem}
.metric:last-child{border:none}
.metric .k{color:#94a3b8}
.metric .v{font-weight:700}
.v.green{color:#22c55e}
.v.red{color:#ef4444}
.v.blue{color:#38bdf8}
.hide{display:none!important}
</style>
</head>
<body>
<div class="wrap">
<div class="head">
<h1>Smart Trader EGX v12.0</h1>
<p>بيانات Stooq · تحليل فني فوري</p>
</div>

<div class="card">
<label>اختر السهم:</label>
<select id="sym">
<option value="COMI">البنك التجاري الدولي (COMI)</option>
<option value="TMGH">مجموعة طلعت مصطفى (TMGH)</option>
<option value="SWDY">السويدي إليكتريك (SWDY)</option>
<option value="ETEL">المصرية للاتصالات (ETEL)</option>
<option value="ABUK">أبو قير للأسمدة (ABUK)</option>
<option value="EFIH">إي فاينانس (EFIH)</option>
<option value="ISPH">ابن سينا فارما (ISPH)</option>
<option value="HRHO">إي إف جي القابضة (HRHO)</option>
<option value="PHDC">بالم هيلز (PHDC)</option>
<option value="FWRY">فوري (FWRY)</option>
</select>
<label style="margin-top:10px">النطاق الزمني:</label>
<select id="rng">
<option value="3mo">3 أشهر</option>
<option value="6mo" selected>6 أشهر</option>
<option value="1y">سنة</option>
<option value="2y">سنتان</option>
</select>
<button id="btn">🔍 تحليل السهم الآن</button>
</div>

<div class="card">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
<strong style="font-size:.9rem">حالة الاتصال:</strong>
<span id="badge" class="badge">في الانتظار</span>
</div>
<div id="result" class="hide">
<div class="metric"><span class="k">الرمز</span><span class="v" id="rSym">-</span></div>
<div class="metric"><span class="k">السعر الحالي</span><span class="v blue" id="rPrice">-</span></div>
<div class="metric"><span class="k">MA20</span><span class="v" id="rMA20">-</span></div>
<div class="metric"><span class="k">MA50</span><span class="v" id="rMA50">-</span></div>
<div class="metric"><span class="k">RSI (14)</span><span class="v" id="rRSI">-</span></div>
<div class="metric"><span class="k">الحجم النسبي</span><span class="v" id="rVol">-</span></div>
<div class="metric"><span class="k">آخر شمعة</span><span class="v" id="rDate">-</span></div>
<div class="metric"><span class="k">عدد الشموع</span><span class="v" id="rBars">-</span></div>
<div class="metric"><span class="k">الإشارة</span><span class="v" id="rSig">-</span></div>
<div class="metric"><span class="k">الدرجة</span><span class="v" id="rScore">-</span></div>
<div class="metric"><span class="k">الأسباب</span><span class="v" id="rWhy" style="font-size:.75rem;text-align:left">-</span></div>
<div class="metric"><span class="k">المصدر</span><span class="v" id="rSrc">-</span></div>
</div>
<div id="err" class="hide" style="padding:10px;background:rgba(239,68,68,.1);border:1px solid #ef4444;border-radius:8px;font-size:.85rem;color:#fca5a5;margin-top:10px"></div>
</div>

<div class="card" style="text-align:center;font-size:.75rem;color:#94a3b8">
بيانات عامة من Stooq — ليست توصية استثمارية
</div>
</div>

<script>
const $=id=>document.getElementById(id);
const btn=$('btn'),badge=$('badge'),res=$('result'),err=$('err');

btn.onclick=async()=>{
  const sym=$('sym').value;
  const rng=$('rng').value;
  btn.disabled=true;btn.textContent='⏳ جارٍ التحليل...';
  badge.className='badge load';badge.textContent='جاري الاتصال...';
  res.classList.add('hide');err.classList.add('hide');

  try{
    const url='/api/quote?symbol='+encodeURIComponent(sym)+'&range='+encodeURIComponent(rng);
    const response=await fetch(url);
    const data=await response.json();

    if(!data.ok){
      badge.className='badge err';badge.textContent='فشل';
      err.textContent='❌ '+(data.error||'خطأ غير معروف');
      err.classList.remove('hide');
      return;
    }

    badge.className='badge ok';badge.textContent='✅ نجح';
    $('rSym').textContent=data.symbol;
    $('rPrice').textContent=data.price+' ج.م';
    $('rMA20').textContent=data.ma20||'—';
    $('rMA50').textContent=data.ma50||'—';
    $('rRSI').textContent=data.rsi||'—';
    $('rVol').textContent=data.relVolume||'—';
    $('rDate').textContent=data.lastDate;
    $('rBars').textContent=data.bars;
    $('rSig').textContent=data.signal;
    $('rSig').className='v '+(data.signal.includes('شراء')?'green':data.signal.includes('بيع')||data.signal.includes('ضعف')?'red':'blue');
    $('rScore').textContent=data.score;
    $('rWhy').textContent=data.reasons;
    $('rSrc').textContent=data.source;
    res.classList.remove('hide');
  }catch(e){
    badge.className='badge err';badge.textContent='خطأ';
    err.textContent='❌ '+e.message;
    err.classList.remove('hide');
  }finally{
    btn.disabled=false;btn.textContent='🔍 تحليل السهم الآن';
  }
};
</script>
</body>
</html>`;
