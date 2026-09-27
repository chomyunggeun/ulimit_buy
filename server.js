"use strict";

// Local-only backend for Toss V4 Trader. Secrets never leave this process except
// for the OAuth token request to the official Toss Securities API.
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const APP_CONFIG_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "TossV4Trader");
const WORKSPACE_CONFIG_DIR = path.join(ROOT, ".local");
let configPath = path.join(APP_CONFIG_DIR, "settings.json");
const API_BASE = "https://openapi.tossinvest.com";
let tokenCache = null;

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8" };

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  response.end(body);
}

function safeMessage(error) {
  const codes = [error?.code, ...(error?.errors || []).map(item => item.code)];
  if (codes.some(code => ["EACCES", "EPERM"].includes(code))) return "서버 실행 환경의 권한 제한으로 요청이 차단되었습니다. 일반 Windows 사용자 권한으로 서버를 다시 실행하세요.";
  return error instanceof Error && error.message ? error.message.replace(/[\r\n]+/g, " ").slice(0, 300) : "서버 통신에 실패했습니다. 네트워크 연결과 서버 실행 권한을 확인하세요.";
}

function dpapi(mode, text) {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows DPAPI가 필요한 기능입니다."));
  const script = "Import-Module Microsoft.PowerShell.Security;$mode=$env:TOSS_V4_DPAPI_MODE;$input=[Console]::In.ReadToEnd();if($mode -eq 'protect'){$plain=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($input));$secure=ConvertTo-SecureString -String $plain -AsPlainText -Force;$out=ConvertFrom-SecureString -SecureString $secure}else{$encrypted=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($input));$secure=ConvertTo-SecureString -String $encrypted;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{$out=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}};[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($out)))";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, env: { ...process.env, TOSS_V4_DPAPI_MODE: mode } });
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", () => reject(new Error("Windows 암호화 저장소를 사용할 수 없습니다.")));
    child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(`Windows 암호화 저장소 오류 (${code}): ${errors.trim()}`)));
    child.stdin.end(Buffer.from(text, "utf8").toString("base64"));
  });
}

async function encrypt(secret) {
  try { return { value: `dpapi:${await dpapi("protect", secret)}`, storage: "Windows DPAPI (CurrentUser)" }; }
  catch { return { value: `local:${Buffer.from(secret, "utf8").toString("base64")}`, storage: "로컬 설정 파일 (암호화 미사용)" }; }
}
async function decrypt(value) {
  if (String(value).startsWith("local:")) return Buffer.from(String(value).slice(6), "base64").toString("utf8");
  const encrypted = String(value).startsWith("dpapi:") ? String(value).slice(6) : value;
  return Buffer.from(await dpapi("unprotect", encrypted), "base64").toString("utf8");
}

async function readConfig() {
  const candidates = [configPath, path.join(WORKSPACE_CONFIG_DIR, "settings.json")];
  for (const candidate of [...new Set(candidates)]) {
    try { const config = JSON.parse(await fsp.readFile(candidate, "utf8")); configPath = candidate; return config; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return {};
}

async function writeConfig(config) {
  const write = async target => {
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, target);
    configPath = target;
  };
  try { await write(configPath); }
  catch (error) {
    if (!["EACCES", "EPERM"].includes(error.code) || configPath === path.join(WORKSPACE_CONFIG_DIR, "settings.json")) throw error;
    await write(path.join(WORKSPACE_CONFIG_DIR, "settings.json"));
  }
}

function publicConfig(config) {
  const id = String(config.clientId || "");
  return {
    clientIdMasked: id ? `${id.slice(0, 5)}…${id.slice(-4)}` : "",
    clientIdConfigured: Boolean(id), secretConfigured: Boolean(config.clientSecretProtected),
    accountSeq: config.accountSeq || "", liveTradingEnabled: Boolean(config.liveTradingEnabled),
    storage: config.secretStorage || (String(config.clientSecretProtected || "").startsWith("local:") ? "로컬 설정 파일 (암호화 미사용)" : "Windows DPAPI (CurrentUser)"),
  };
}

function remoteRequest(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body) : null;
    const req = https.request(`${API_BASE}${pathname}`, { method, headers: { ...headers, ...(data ? { "Content-Length": data.length } : {}) }, timeout: 15000 }, res => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { responseBody += chunk; });
      res.on("end", () => {
        let parsed; try { parsed = responseBody ? JSON.parse(responseBody) : {}; } catch { parsed = {}; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, data: parsed });
        const reason = parsed?.error?.message || parsed?.error_description || "토스증권 API 요청이 거부되었습니다.";
        const error = new Error(`${res.statusCode}: ${reason}`); error.status = res.statusCode; reject(error);
      });
    });
    req.on("timeout", () => req.destroy(new Error("토스증권 API 응답 시간이 초과되었습니다.")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function accessToken(config) {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.value;
  if (!config.clientId || !config.clientSecretProtected) throw new Error("클라이언트 ID와 시크릿을 먼저 저장하세요.");
  const secret = await decrypt(config.clientSecretProtected);
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: secret }).toString();
  const result = await remoteRequest("POST", "/oauth2/token", { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  if (!result.data.access_token) throw new Error("액세스 토큰을 받지 못했습니다.");
  tokenCache = { value: result.data.access_token, expiresAt: Date.now() + Number(result.data.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

async function tossApi(config, method, pathname, { account = false, body } = {}) {
  const token = await accessToken(config);
  const headers = { Authorization: `Bearer ${token}` };
  if (account) {
    if (!config.accountSeq) throw new Error("계좌 순번(accountSeq)을 선택하세요.");
    headers["X-Tossinvest-Account"] = String(config.accountSeq);
  }
  if (body) headers["Content-Type"] = "application/json";
  return remoteRequest(method, pathname, { headers, body: body ? JSON.stringify(body) : undefined });
}

function positiveDecimal(value) { return typeof value === "string" && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 && value.length <= 30; }
function validateOrder(input) {
  const symbol = String(input.symbol || "").toUpperCase();
  const side = String(input.side || "");
  const orderType = String(input.orderType || "");
  const timeInForce = String(input.timeInForce || "DAY");
  if (!/^[A-Z0-9.\-]+$/.test(symbol)) throw new Error("종목 심볼 형식이 올바르지 않습니다.");
  if (!["BUY", "SELL"].includes(side)) throw new Error("매수 또는 매도를 선택하세요.");
  if (!["LIMIT", "MARKET"].includes(orderType)) throw new Error("지원하지 않는 주문 유형입니다.");
  if (!["DAY", "CLS", "OPG"].includes(timeInForce)) throw new Error("지원하지 않는 주문 유효조건입니다.");
  if (timeInForce === "CLS" && orderType !== "LIMIT") throw new Error("LOC(CLS)는 지정가 주문에만 사용할 수 있습니다.");
  const order = { clientOrderId: `v4-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`, symbol, side, orderType, timeInForce };
  if (input.orderAmount) {
    if (orderType !== "MARKET" || !positiveDecimal(String(input.orderAmount))) throw new Error("금액 주문은 양수 금액의 미국 시장가 주문만 지원합니다.");
    order.orderAmount = String(input.orderAmount);
  } else {
    if (!positiveDecimal(String(input.quantity || ""))) throw new Error("양수 주문 수량을 입력하세요.");
    order.quantity = String(input.quantity);
    if (orderType === "LIMIT") {
      if (!positiveDecimal(String(input.price || ""))) throw new Error("지정가 주문에는 양수 가격이 필요합니다.");
      order.price = String(input.price);
    }
  }
  return order;
}

async function readBody(request) {
  let text = "";
  for await (const chunk of request) { text += chunk; if (text.length > 100_000) throw new Error("요청 본문이 너무 큽니다."); }
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error("JSON 형식이 올바르지 않습니다."); }
}

async function api(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/health") return json(response, 200, { ok: true, mode: "LOCAL", liveOrderEndpoint: true });
  if (request.method === "GET" && pathname === "/api/settings") return json(response, 200, publicConfig(await readConfig()));
  if (request.method === "POST" && pathname === "/api/settings") {
    const input = await readBody(request); const previous = await readConfig();
    const clientId = String(input.clientId || previous.clientId || "").trim();
    const secret = String(input.clientSecret || "");
    if (!clientId) throw new Error("클라이언트 ID를 입력하세요.");
    if (!previous.clientSecretProtected && !secret) throw new Error("처음 저장할 때는 클라이언트 시크릿이 필요합니다.");
    if (input.accountSeq && !/^\d+$/.test(String(input.accountSeq))) throw new Error("계좌 순번은 숫자여야 합니다.");
    const protectedSecret = secret ? await encrypt(secret) : { value: previous.clientSecretProtected, storage: previous.secretStorage };
    const next = { clientId, clientSecretProtected: protectedSecret.value, secretStorage: protectedSecret.storage, accountSeq: String(input.accountSeq || "").trim(), liveTradingEnabled: Boolean(input.liveTradingEnabled), updatedAt: new Date().toISOString() };
    await writeConfig(next); tokenCache = null;
    return json(response, 200, { ok: true, settings: publicConfig(next) });
  }
  if (request.method === "POST" && pathname === "/api/test-connection") {
    const config = await readConfig();
    const token = await accessToken(config);
    const accounts = await remoteRequest("GET", "/api/v1/accounts", { headers: { Authorization: `Bearer ${token}` } });
    const prices = await remoteRequest("GET", "/api/v1/prices?symbols=TQQQ", { headers: { Authorization: `Bearer ${token}` } });
    const list = accounts.data?.result || [];
    return json(response, 200, { ok: true, accounts: list.map(account => ({ accountSeq: account.accountSeq, accountNoMasked: String(account.accountNo || "").replace(/.(?=.{4})/g, "•"), accountType: account.accountType })), price: prices.data?.result?.[0] || null });
  }
  if (request.method === "POST" && pathname === "/api/live-order") {
    const input = await readBody(request); const config = await readConfig();
    if (!config.liveTradingEnabled) return json(response, 403, { error: "실주문 전송이 설정에서 비활성화되어 있습니다." });
    if (input.confirmation !== "LIVE ORDER") return json(response, 400, { error: "실주문 확인 문구가 일치하지 않습니다." });
    const order = validateOrder(input); const result = await tossApi(config, "POST", "/api/v1/orders", { account: true, body: order });
    return json(response, 200, { ok: true, order: result.data?.result || result.data });
  }
  return json(response, 404, { error: "API 경로를 찾을 수 없습니다." });
}

http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${HOST}`).pathname;
    if (pathname.startsWith("/api/")) return await api(request, response, pathname);
    if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "허용되지 않은 요청입니다." });
    if (!["/", "/index.html", "/strategy-v4.json"].includes(pathname)) return json(response, 404, { error: "파일을 찾을 수 없습니다." });
    const relative = pathname === "/" ? "index.html" : `.${pathname}`;
    const filePath = path.resolve(ROOT, relative);
    if (!filePath.startsWith(`${ROOT}${path.sep}`)) return json(response, 403, { error: "접근이 거부되었습니다." });
    const content = await fsp.readFile(filePath);
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) { json(response, error.status || 400, { error: safeMessage(error) }); }
}).listen(PORT, HOST, () => console.log(`Toss V4 Trader local server: http://${HOST}:${PORT}`));
