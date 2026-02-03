# Diagnóstico: Por que a integração do Gemini CLI funciona no OpenClaw mas falhou na nova implementação?

Este documento explica a discrepância entre a implementação funcional existente no OpenClaw e as falhas relatadas na tentativa de replicação (Erro 404 / 403).

## Resumo do Problema

O relatório de desafios (`docs/gemini-cli-challenges.md`) descreve tentativas falhas de adivinhar o endpoint de chat da API interna `cloudcode-pa.googleapis.com` usando padrões da Vertex AI (ex: `/v1internal/projects/{id}/models/{model}:streamGenerateContent`).

No entanto, o OpenClaw **já funciona** utilizando esta mesma API interna com sucesso. A análise do código fonte da biblioteca `@mariozechner/pi-ai` (usada pelo OpenClaw) revela o endpoint exato e o formato de corpo esperado, que diferem radicalmente da API pública.

## A Solução (O Endpoint "Mágico")

Ao contrário da Vertex AI, que codifica o projeto e o modelo na URL, a API interna do Cloud Code usa um **endpoint raiz genérico** e espera que os detalhes do projeto/modelo estejam no **corpo do JSON**.

### 1. URL Correta
*   **Base:** `https://cloudcode-pa.googleapis.com`
*   **Path:** `/v1internal:streamGenerateContent`
*   **Query Params:** `?alt=sse` (Server-Sent Events)

**URL Completa:**
```
POST https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
```

### 2. Estrutura do Corpo (JSON Body)
O corpo da requisição deve conter `project` e `model` como campos de nível superior, além de `request` contendo os dados padrão do Gemini.

```json
{
  "project": "seu-projeto-id",
  "model": "gemini-1.5-pro-preview-0409",
  "request": {
    "contents": [
      {
        "role": "user",
        "parts": [{ "text": "Olá mundo" }]
      }
    ],
    "generationConfig": { ... }
  },
  "userAgent": "pi-coding-agent",
  "requestId": "pi-..."
}
```

### 3. Headers Necessários
Além do token OAuth (escopo `cloud-platform`), headers específicos são necessários para imitar o cliente oficial:

```
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: text/event-stream
User-Agent: google-cloud-sdk vscode_cloudshelleditor/0.1
X-Goog-Api-Client: gl-node/22.17.0
Client-Metadata: {"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}
```

## Por que a nova implementação falhou?

As tentativas descritas no relatório de falhas assumiram que a API interna seguia o padrão REST da Vertex AI:
*   ❌ `POST /v1internal/projects/.../models/...:streamGenerateContent` -> **404 Not Found**

Como o endpoint correto é genérico (`/v1internal:streamGenerateContent`), qualquer tentativa de usar caminhos hierárquicos resulta em 404.

## Conclusão para o Agente

Para fazer a nova implementação funcionar igual ao OpenClaw e aproveitar o acesso "gratuito" (via Cloud Code):

1.  **Não use** a API da Vertex AI (`aiplatform.googleapis.com`) se quiser evitar billing explícito.
2.  **Use** o endpoint `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`.
3.  **Monte o JSON** colocando `project` e `model` na raiz do objeto, envolvendo o resto da payload em um objeto `request`.
4.  Mantenha o fluxo de Auth atual (que já obtém o token correto com escopo `cloud-platform`).
