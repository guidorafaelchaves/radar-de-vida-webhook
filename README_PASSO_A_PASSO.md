# Radar de Vida — WhatsApp Webhook v0.1

Este pacote cria um backend local em Node.js para receber mensagens do WhatsApp Cloud API via webhook, analisar cada frase com OpenAI ou heurística local, salvar em JSON e exibir tudo em um painel web.

## 1. O que ele faz

- Recebe webhook do WhatsApp em `POST /webhook/whatsapp`
- Verifica o webhook da Meta em `GET /webhook/whatsapp`
- Extrai mensagens de texto do payload da Meta
- Analisa mensagens usando OpenAI se `OPENAI_API_KEY` estiver configurada
- Usa análise local offline se a OpenAI não estiver configurada
- Salva os registros em `data/radar-db.json`
- Responde no WhatsApp com uma confirmação curta, se configurado
- Exibe painel em `http://localhost:3000`

## 2. Instalação

Instale Node.js 20 ou superior.

No terminal, dentro da pasta do projeto:

```bash
npm install
cp .env.example .env
npm start
```

No Windows, se o comando `cp` não funcionar, copie manualmente o arquivo `.env.example` e renomeie a cópia para `.env`.

Abra:

```text
http://localhost:3000
```

## 3. Teste sem WhatsApp

Com o servidor rodando, abra o painel e envie uma frase no campo "Teste local de mensagem".

Exemplo:

```text
gastei 61 no iFood porque estava exausto depois da audiência
```

Também é possível testar por terminal:

```bash
curl -X POST http://localhost:3000/api/test-message ^
  -H "Content-Type: application/json" ^
  -d "{"text":"gastei 61 no iFood porque estava exausto depois da audiência"}"
```

No PowerShell:

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/api/test-message `
  -ContentType "application/json" `
  -Body '{"text":"gastei 61 no iFood porque estava exausto depois da audiência"}'
```

## 4. Configurar OpenAI

No arquivo `.env`:

```env
OPENAI_API_KEY=sua_chave_aqui
OPENAI_MODEL=gpt-5.4-mini
```

Se a chave ficar vazia, o sistema usa análise offline local.

## 5. Configurar WhatsApp Cloud API

No painel Meta for Developers:

1. Crie ou abra seu App.
2. Adicione o produto WhatsApp.
3. Configure um número de teste ou número real do WhatsApp Business.
4. Copie:
   - `WHATSAPP_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
5. No `.env`, preencha:

```env
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
VERIFY_TOKEN=radar_de_vida_teste_123
```

O `VERIFY_TOKEN` é uma palavra/frase escolhida por você. Ela precisa ser igual no `.env` e no campo de verificação do webhook na Meta.

## 6. Expor servidor local para a Meta

A Meta precisa acessar uma URL HTTPS pública. Para teste local, use ngrok ou Cloudflare Tunnel.

Exemplo com ngrok:

```bash
ngrok http 3000
```

Ele vai gerar uma URL parecida com:

```text
https://abc123.ngrok-free.app
```

No painel da Meta, configure o webhook:

```text
Callback URL:
https://abc123.ngrok-free.app/webhook/whatsapp

Verify token:
radar_de_vida_teste_123
```

Depois assine o campo de webhook de mensagens, normalmente chamado `messages`.

## 7. URLS úteis

- Painel: `http://localhost:3000`
- Saúde do servidor: `http://localhost:3000/health`
- Webhook Meta GET/POST: `/webhook/whatsapp`
- Teste local: `POST /api/test-message`
- Registros: `GET /api/records`
- Exportação: `GET /api/export`

## 8. Observação sobre grupo de WhatsApp

O teste mais estável é enviar mensagens diretamente para o número WhatsApp Business conectado à Cloud API.

Captura automática de mensagens de um grupo comum do seu WhatsApp pessoal não funciona com HTML local. Recursos oficiais de grupos dependem de suporte/escopo da plataforma Meta para a conta/app. Por isso esta versão prepara o webhook profissional e o parser, mas a validação inicial deve ser feita por mensagem direta ao número Business.

## 9. Produção futura

Para produto real, evoluir:

- banco JSON -> PostgreSQL/Supabase
- token temporário -> token permanente
- ngrok -> domínio HTTPS próprio
- local dashboard -> PWA hospedado
- app secret obrigatório
- autenticação de usuários
- LGPD: exportar/apagar dados, consentimento, política de privacidade

