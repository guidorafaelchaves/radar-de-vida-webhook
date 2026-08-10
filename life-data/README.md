# Radar Life Data Engine

Este diretorio prepara a Fase 2 do Life Data Engine sem conectar nada em producao.

Estado atual:

- migrations SQL iniciais;
- normalizadores canonicos isolados;
- testes sinteticos;
- nenhuma importacao pelo `server.js`;
- nenhuma escrita em banco;
- nenhuma alteracao no fluxo WhatsApp, Zepp, Apps Script ou dashboard atual.

Para validar localmente:

```powershell
npm run test:life-data
```

Proximo passo tecnico, quando autorizado:

1. escolher Postgres gerenciado;
2. configurar `LIFE_DATA_DATABASE_URL` no ambiente;
3. criar um executor de migrations;
4. manter `LIFE_DATA_ENGINE_ENABLED=false` ate o storage estar validado;
5. espelhar dados do Radar atual somente com `LIFE_DATA_SEMANTIC_MIRROR_ENABLED=true`.

