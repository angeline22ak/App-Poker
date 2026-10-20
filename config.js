// Configuração do Supabase (chave publishable — segura para uso no navegador; RLS protege o banco)
window.POKER_CONFIG = {
  SUPABASE_URL: "https://zzgemyzcspzcsffaszsx.supabase.co",
  SUPABASE_KEY: "sb_publishable_0X_aNmuMi9XBL_WI-FOACg_zeCH4cXJ",

  // Transmissão da mesa (opcional): URL de EMBED do stream. Vazio = seção escondida.
  // YouTube Live (não listado): "https://www.youtube.com/embed/VIDEO_ID?autoplay=1&mute=1"
  // Twitch: "https://player.twitch.tv/?channel=SEU_CANAL&parent=app-poker-eight.vercel.app&muted=true"
  STREAM_EMBED_URL: ""
};
