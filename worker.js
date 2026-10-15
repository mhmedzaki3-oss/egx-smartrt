export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // توجيه الطلبات أو جلب البيانات حسب الحاجة
      return new Response(JSON.stringify({ ok: true, message: "Smart Trader EGX Worker is active" }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
