# Relatório de Implementação: Integração Telegram

Este relatório detalha a implementação do canal Telegram no projeto OpenClaw, com o objetivo de facilitar sua extração e reutilização em outros projetos de agentes de IA.

## 1. Visão Geral da Arquitetura

A integração é construída sobre o framework [grammY](https://grammy.dev/), uma biblioteca moderna e leve para o ecossistema Node.js. A arquitetura foi desenhada para suportar alta concorrência, recuperação de falhas de rede e, crucialmente, o comportamento humano de envio de mensagens (múltiplas mensagens curtas, álbuns de mídia, etc.).

Componentes principais:
1.  **Core do Bot (`src/telegram/bot.ts`)**: Configuração da instância `Bot`, middleware de sequenciamento e tratamento de erros.
2.  **Handlers Avançados (`src/telegram/bot-handlers.ts`)**: Lógica complexa de *debouncing* e agrupamento de mensagens.
3.  **Transporte (`src/telegram/webhook.ts`)**: Servidor HTTP para receber updates via Webhook.
4.  **Envio (`src/telegram/send.ts`)**: Abstração robusta para envio de respostas, com suporte a retries e formatação.

## 2. Configuração e Inicialização

A inicialização ocorre em `src/telegram/bot.ts` através da função `createTelegramBot`.

### Características Chave:
*   **Throttling**: Uso do `@grammyjs/transformer-throttler` para respeitar os limites de taxa da API do Telegram automaticamente.
*   **Sequentialize**: Middleware que garante que mensagens do mesmo chat sejam processadas em ordem, prevenindo condições de corrida no estado do agente.
*   **Webhook vs Polling**: O código suporta Webhook (`src/telegram/webhook.ts`) para produção, montando um servidor Node.js nativo (`node:http`) que processa requisições POST do Telegram.

## 3. Estratégia de Processamento de Mensagens

Esta é a parte mais valiosa para reutilização em projetos de IA. O Telegram entrega cada mensagem como um evento separado, mas usuários tendem a enviar "pensamentos" fragmentados. O arquivo `src/telegram/bot-handlers.ts` implementa três estratégias de bufferização para consolidar o contexto antes de invocar a IA.

### A. Debouncing (Inbound Debouncer)
Usuários frequentemente enviam várias mensagens curtas em sequência rápida:
> "Oi"
> "Tudo bem?"
> "Preciso de ajuda"

O sistema usa um `createInboundDebouncer` que aguarda um intervalo configurável (ex: 1-2 segundos). Se novas mensagens chegam, o timer reseta. Ao final, o sistema concatena todos os textos e envia um único prompt para o Agente.

### B. Media Groups (Álbuns)
Quando um usuário envia um álbum de 5 fotos, o Telegram dispara 5 updates quase simultâneos. O sistema detecta o `media_group_id` e armazena as mensagens em um buffer (`mediaGroupBuffer`). Após um timeout curto (ex: `MEDIA_GROUP_TIMEOUT_MS`), processa todas as mídias juntas, permitindo que a IA "veja" todas as imagens de uma vez.

### C. Fragmentação de Texto Longo
Se o usuário (ou outro bot) cola um texto gigante que excede o limite do Telegram (4096 caracteres), o Telegram o quebra em várias mensagens. O handler detecta isso (baseado em timestamp e IDs sequenciais) e reconstrói o texto original em `textFragmentBuffer` antes de processá-lo.

## 4. Sistema de Envio (Outbound)

Localizado em `src/telegram/send.ts`, o sistema de envio trata complexidades de formatação:

*   **HTML vs Markdown**: Tenta enviar como HTML por padrão. Se o Telegram rejeitar (tags inválidas), faz fallback automático para texto plano ou tenta sanitizar.
*   **Caption Splitting**: Se a resposta da IA inclui uma imagem e um texto longo que excede o limite de legenda (caption), o sistema automaticamente envia a imagem primeiro e o texto como uma mensagem subsequente.
*   **Retries**: Implementa política de retry para falhas de rede transitórias (`src/infra/retry-policy.ts`).

## 5. Guia de Reutilização

Para portar essa implementação para outro projeto, você precisará dos seguintes componentes.

### Dependências (package.json)
```json
{
  "dependencies": {
    "grammy": "^1.x",
    "@grammyjs/runner": "^2.x",
    "@grammyjs/transformer-throttler": "^1.x",
    "@grammyjs/types": "^3.x"
  }
}
```

### Arquivos Essenciais
Copie o diretório `src/telegram/` mantendo a estrutura. Os arquivos críticos são:

1.  `bot.ts`: Instanciação e middlewares.
2.  `bot-handlers.ts`: A lógica de Buffer/Debounce (essencial para UX de Chatbot).
3.  `webhook.ts`: Se for usar Webhooks.
4.  `send.ts`: Utilitários de envio.

### Adaptações Necessárias
Ao copiar, você precisará remover acoplamentos com o core do OpenClaw:
1.  **Config**: Substitua chamadas a `loadConfig()` e `cfg.*` pelo seu próprio gerenciador de configuração ou variáveis de ambiente.
2.  **Logs**: Substitua `runtime.log` e `logVerbose` por `console.log` ou seu logger preferido (Winston, Pino).
3.  **Process Message**: Em `bot-handlers.ts`, a função `processMessage` é onde o OpenClaw chama o Agente. Substitua essa chamada pela lógica do seu bot (ex: chamar OpenAI/LangChain).

### Exemplo de Handler Simplificado
Se for extrair apenas a lógica de debouncing:
```typescript
// Pseudocódigo baseado em bot-handlers.ts
const debouncer = createInboundDebouncer({
  debounceMs: 2000,
  onFlush: async (entries) => {
    const fullText = entries.map(e => e.msg.text).join("\n");
    await myAgent.process(fullText);
  }
});

bot.on("message:text", (ctx) => {
  debouncer.enqueue({ ctx, msg: ctx.message });
});
```

## Arquivos de Referência no Repositório
*   `src/telegram/bot.ts`
*   `src/telegram/bot-handlers.ts`
*   `src/telegram/webhook.ts`
*   `src/telegram/send.ts`
