# Radar Zepp Health Bridge

Primeiro passo da integracao Amazfit T-Rex 3 -> Zepp -> Radar da Vida.

## Arquitetura escolhida

O caminho principal deve ser:

`Amazfit T-Rex 3 -> Zepp no celular -> Health Connect -> app ponte Android -> /api/zepp-health-snapshot -> Radar da Vida`

O relogio continua sendo o sensor. O celular vira o hub confiavel de permissao, rede e sincronizacao. O Radar recebe snapshots decisorios, nao series brutas minuto a minuto.

## Endpoint

`POST /api/zepp-health-snapshot`

Autenticacao:

`Authorization: Bearer <RADAR_API_TOKEN>`

ou:

`X-Radar-Token: <RADAR_API_TOKEN>`

## Campos aceitos

Campos diretos:

- `source`
- `deviceId`
- `deviceModel`
- `date`
- `steps`
- `activeMinutes`
- `activeCalories`
- `totalCalories`
- `distanceMeters`
- `sleepMinutes`
- `sleepStart`
- `sleepEnd`
- `deepSleepMinutes`
- `remSleepMinutes`
- `awakeMinutes`
- `restingHeartRate`
- `avgHeartRate`
- `maxHeartRate`
- `workoutType`
- `workoutMinutes`
- `workoutCalories`
- `workoutDistanceMeters`
- `weightKg`
- `spo2`
- `stress`

Tambem aceita objetos aninhados:

- `sleep`
- `heartRate`
- `workout`
- `activity`
- `body`

Veja `zepp_health_snapshot_example.json`.

## O que o endpoint faz

1. Normaliza o snapshot.
2. Gera uma frase decisoria humana.
3. Envia essa frase para o mesmo pipeline do Radar.
4. Salva no Google Docs como entrada `zepp_health_snapshot`.
5. Preserva o snapshot bruto em `raw.snapshot`.

## Exemplo PowerShell

```powershell
$token = "COLE_SEU_RADAR_API_TOKEN"
$body = Get-Content .\zepp_health_snapshot_example.json -Raw
Invoke-RestMethod `
  -Uri "https://radar-de-vida-webhook.onrender.com/api/zepp-health-snapshot" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body $body
```

## Proximo passo

Criar o app Android `RadarZeppBridge` com Health Connect:

- pedir permissao de leitura para passos, sono, exercicios, calorias, distancia, batimentos, peso e SpO2 quando disponivel;
- ler agregados diarios;
- enviar snapshots 1 a 4 vezes por dia;
- oferecer botao "Sincronizar agora";
- guardar ultimo `date` sincronizado para evitar duplicidade.
