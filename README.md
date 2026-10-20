# Mesa Poker 🂡

Webapp (PWA) de gestão financeira para mesa de poker **cash game**: buy-in, rebuy,
cash-out e **rake por mão** (contado pela cor e quantidade das fichas), com painel
do admin e conta do jogador atualizadas **em tempo real**.

## Funcionalidades (MVP)

- **Admin (PIN):** abre/fecha mesas, cadastra jogadores, lança buy-in/rebuy/cash-out,
  registra o rake de cada mão tocando nas fichas recolhidas (cor × quantidade → R$),
  com pote estimado opcional para calcular a **% da casa**.
- **Jogador (nome + PIN):** vê a própria conta ao vivo — quanto comprou, sacou,
  resultado — e as estatísticas da mesa.
- **Mesa ao vivo (público):** rake total, rake médio/mão, % média da casa,
  rake/hora, dinheiro na mesa, últimas mãos.
- **PWA instalável:** botão "Instalar na tela inicial" (Android/Chrome mostra o
  prompt nativo; iOS mostra o passo a passo de Compartilhar → Adicionar à Tela de Início).
- **Tempo real:** Supabase Realtime — qualquer lançamento aparece em todos os
  aparelhos conectados em ~1s.

## Stack

| Camada | Tecnologia |
| --- | --- |
| Frontend | HTML/CSS/JS puro (sem build), supabase-js via CDN |
| Banco + Realtime | Supabase (Postgres, RLS, RPCs `security definer`) |
| Hospedagem | Vercel (site estático) |

## Segurança (nível MVP)

- Leitura dos dados da mesa é pública (link = acesso de leitura).
- **Toda escrita** passa por funções RPC que validam o PIN do admin no servidor
  (hash bcrypt via pgcrypto). O cliente nunca escreve direto nas tabelas (RLS).
- PINs de jogador apenas dão acesso de leitura da conta.
- Para produção real: migrar para Supabase Auth + projeto dedicado + rate limiting.

## Banco de dados

Schema completo em [`db/schema.sql`](db/schema.sql). Tabelas com prefixo `poker_`
(hospedadas temporariamente no projeto Supabase existente por limite do plano free).

## Desenvolvimento

É um site estático — basta servir a raiz do repositório:

```bash
npx serve .
```

A configuração do Supabase (URL + chave publishable, segura para browser) está em
`config.js`.
