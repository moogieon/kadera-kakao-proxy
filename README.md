# kadera-kakao-proxy

Kakao Cloud용 카더라 MCP proxy 서버입니다.

이 서버는 API 키를 저장하지 않습니다. PlayMCP에서 들어온 MCP `check_claim` 호출을 기존 Railway 카더라 백엔드로 전달하고, 백엔드 응답을 MCP text 응답으로 반환합니다.

## Kakao Cloud Git Source Build

- Git URL: `https://github.com/moogieon/kadera-kakao-proxy.git`
- Branch/ref: `main`
- Dockerfile path: `Dockerfile`
- PAT: public repo이므로 비움

## Runtime

기본 백엔드:

```text
KADERA_BACKEND_URL=https://kadera-malgo-production.up.railway.app
```

MCP endpoint:

```text
/mcp
```

Health check:

```text
/healthz
```
