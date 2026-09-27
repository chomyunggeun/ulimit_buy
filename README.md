# Toss V4 Trader

무한매수법 V4용 개인 자동매매 대시보드 초안입니다.

## 현재 구현
- TQQQ / SOXL, 20/40분할
- NORMAL: 첫 매수 / 전반전 / 후반전
- 별지점, 1회 매수금, 쿼터 LOC 매도, 목표 지정가 매도
- REVERSE: T >= N-1 진입, 첫날 MOC 매도, 이후 LOC 매도 + 잔금 1/4 LOC 매수 구조
- TQQQ -15% / SOXL -20% 회복선 표시
- 자동매매 ON/OFF 및 긴급중지 UI
- 토스증권 현재가 API 서버 연결 예제
- 기본 LIVE 주문 차단

## 실행
### 가장 간단히
`index.html`을 브라우저로 열면 MOCK MODE에서 바로 작동합니다.

### 로컬 서버
```bash
python server.py
```
브라우저에서 `http://127.0.0.1:8000`

### 토스 현재가 API 사용
```bash
# macOS/Linux
export TOSS_ACCESS_TOKEN="..."
python server.py
```

Windows PowerShell:
```powershell
$env:TOSS_ACCESS_TOKEN="..."
python server.py
```

## 중요
실제 주문 전송 코드는 기본적으로 잠겨 있습니다.
실계좌 자동 주문은 토스증권의 현재 주문 스키마, LOC/MOC 지원 값, 주문 가능 시간, 정정/취소 규칙을 계정 환경에서 검증한 다음 연결해야 합니다.

토큰을 HTML/JavaScript에 직접 넣지 마세요. 반드시 서버 환경변수로 보관하세요.
