/**
 * 이거돼? — AI 기반 약물 판독 & 복약 가이드
 * Stack: React + Vite + Tailwind CSS + Firebase + Groq + 식약처 API
 *
 * [v2 변경사항]
 * - 이메일/비밀번호 로그인 + 게스트 모드 추가
 * - Firestore users/{uid} role 기반 관리자 권한
 * - AdminView: 유저 목록/관리, corrections 실시간, 통계 개선
 * - HistoryView: Base64 이미지 압축 + 썸네일 (Storage 미사용)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Camera, ImagePlus, Send, ChevronRight, Clock, AlertTriangle,
  CheckCircle, XCircle, Pill, MessageCircle, History,
  Loader2, Sparkles, RefreshCw, ChevronLeft,
  Shield, Zap, X, Database, LogOut, Users, UserCheck, UserX
} from 'lucide-react'

import { initializeApp, getApps } from 'firebase/app'
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail,
} from 'firebase/auth'
import {
  getFirestore, collection, addDoc, query, orderBy, limit,
  onSnapshot, serverTimestamp, doc, getDoc, setDoc, updateDoc, getDocs,
} from 'firebase/firestore'
// Storage 미사용 (이미지는 Base64로 Firestore에 저장)

// ─── 환경변수 ─────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

const APP_ID = import.meta.env.VITE_APP_ID || 'igeordwae-dev'
const MFDS_API_KEY = import.meta.env.VITE_MFDS_API_KEY
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
// Groq API는 CORS 미지원 → 서버리스 프록시 경유 (키도 서버 환경변수로만 보관)
const GROQ_PROXY = '/api/groq-proxy'
// DL 모델 추론 서버 (학습 완료 후 ml/server.py 실행 시 활성화)
// 프로덕션(Vercel)에선 VITE_MODEL_PROXY_URL(ngrok 주소)로 직접 호출, 없으면 dev 프록시
const MODEL_PROXY = import.meta.env.VITE_MODEL_PROXY_URL || '/api/model-inference'

// ─── 식약처 API 엔드포인트 (Vercel 프록시 경유) ───────────────────────────────
const MFDS_PROXY = '/api/mfds-proxy'
const MFDS_DRUG_INFO_URL = `${MFDS_PROXY}?endpoint=drugInfo`
const MFDS_PILL_INFO_URL = `${MFDS_PROXY}?endpoint=pillInfo`
const MFDS_PRMISN_URL   = `${MFDS_PROXY}?endpoint=permission`

// ─── DUR API 엔드포인트 (프록시 경유) ──────────────────────────────────────────
const DUR_ENDPOINTS = {
  병용금기:   `${MFDS_PROXY}?endpoint=durCombination`,
  임부금기:   `${MFDS_PROXY}?endpoint=durPregnancy`,
  노인주의:   `${MFDS_PROXY}?endpoint=durElderly`,
  효능군중복: `${MFDS_PROXY}?endpoint=durDuplicate`,
}

// ─── Firebase 초기화 ──────────────────────────────────────────────────────────
let app, auth, db
try {
  app  = getApps().length ? getApps()[0] : initializeApp(firebaseConfig)
  auth = getAuth(app)
  db   = getFirestore(app)
} catch (e) {
  console.warn('Firebase 초기화 실패:', e.message)
}

const LOGS_PATH        = () => collection(db, `artifacts/${APP_ID}/public/data/analysis_logs`)
const CORRECTIONS_PATH = () => collection(db, `artifacts/${APP_ID}/public/data/corrections`)
const USERS_PATH       = () => collection(db, 'users')

// ─── Auth 에러 → 한국어 ───────────────────────────────────────────────────────
function getAuthErrorMsg(code) {
  const map = {
    'auth/invalid-email':          '올바른 이메일 형식이 아닙니다.',
    'auth/user-disabled':          '비활성화된 계정입니다.',
    'auth/user-not-found':         '등록되지 않은 이메일입니다.',
    'auth/wrong-password':         '비밀번호가 올바르지 않습니다.',
    'auth/invalid-credential':     '이메일 또는 비밀번호가 맞지 않습니다.',
    'auth/email-already-in-use':   '이미 사용 중인 이메일입니다.',
    'auth/weak-password':          '비밀번호는 6자 이상이어야 합니다.',
    'auth/too-many-requests':      '잠시 후 다시 시도해주세요.',
    'auth/network-request-failed': '네트워크 오류가 발생했습니다.',
  }
  return map[code] || '인증 오류가 발생했습니다.'
}

// ─── AuthView (로그인 / 회원가입 / 비밀번호 찾기 / 게스트) ─────────────────────
function AuthView({ onGuest }) {
  // tab: 'login' | 'signup'  /  showReset: boolean
  const [tab, setTab]           = useState('login')
  const [showReset, setShowReset] = useState(false)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [resetSent, setResetSent] = useState(false)

  const switchTab = (next) => { setTab(next); setError(''); setEmail(''); setPassword('') }
  const openReset = () => { setShowReset(true); setError(''); setResetSent(false) }
  const closeReset = () => { setShowReset(false); setError('') }

  const handleSubmit = async () => {
    if (!email.trim()) { setError('이메일을 입력해주세요.'); return }
    if (!showReset && !password) { setError('비밀번호를 입력해주세요.'); return }
    setLoading(true); setError('')
    try {
      if (showReset) {
        await sendPasswordResetEmail(auth, email.trim())
        setResetSent(true)
      } else if (tab === 'login') {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password)
        await setDoc(doc(db, 'users', cred.user.uid), {
          email: cred.user.email, role: 'user',
          createdAt: serverTimestamp(), lastLogin: serverTimestamp(),
        })
      }
    } catch (err) { setError(getAuthErrorMsg(err.code)) }
    finally { setLoading(false) }
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-white overflow-hidden">

      {/* ── 상단 헤더 (앱과 동일한 그라데이션) ── */}
      <div className="px-5 pt-12 pb-10 bg-gradient-to-b from-[#0192F5] to-[#40BEFD] flex flex-col items-center gap-3 flex-shrink-0">
        {/* 로고 */}
        <div className="relative">
          <img
            src="/logo.png"
            alt="이거돼?"
            className="object-cover shadow-2xl"
            style={{ width: 84, height: 84, borderRadius: 24 }}
            onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex' }}
          />
          <div
            className="items-center justify-center text-4xl shadow-xl"
            style={{ display: 'none', width: 84, height: 84, borderRadius: 24, background: 'rgba(255,255,255,0.25)' }}
          >💊</div>
        </div>
        <div className="text-center">
          <h1 className="text-white font-black text-2xl leading-tight">이거 돼?</h1>
          <p className="text-white/75 text-sm mt-0.5">AI 약물 판독 서비스</p>
        </div>
      </div>

      {/* ── 하단 폼 영역 ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 pt-6 pb-10 flex flex-col gap-5">

          {/* ── 비밀번호 재설정 패널 ── */}
          {showReset ? (
            <div className="space-y-4">
              <button onClick={closeReset} className="flex items-center gap-1.5 text-sm text-slate-500 font-semibold">
                <ChevronLeft size={16} /> 돌아가기
              </button>
              <div>
                <p className="font-black text-slate-800 text-lg">비밀번호 재설정</p>
                <p className="text-xs text-slate-400 mt-1">가입한 이메일로 재설정 링크를 보내드려요</p>
              </div>
              {resetSent ? (
                <div className="bg-blue-50 rounded-3xl p-6 text-center space-y-3 border border-blue-100">
                  <div className="text-4xl">📧</div>
                  <div>
                    <p className="font-bold text-slate-800 text-sm">메일을 확인해주세요!</p>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      <span className="text-[#0192F5] font-semibold">{email}</span>으로<br/>재설정 링크를 전송했어요.
                    </p>
                  </div>
                  <button onClick={closeReset}
                    className="w-full py-3 rounded-2xl text-sm font-bold text-white"
                    style={{ background: 'linear-gradient(135deg, #0192F5, #40BEFD)' }}>
                    로그인으로 돌아가기
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <InputField label="이메일 주소" type="email" value={email} onChange={setEmail} placeholder="example@email.com" autoComplete="email" />
                  {error && <ErrorMsg msg={error} />}
                  <SubmitBtn loading={loading} onClick={handleSubmit} label="재설정 메일 보내기" />
                </div>
              )}
            </div>
          ) : (
            <>
              {/* ── 탭 ── */}
              <div className="flex bg-slate-100 rounded-2xl p-1 gap-1">
                {[['login','로그인'],['signup','회원가입']].map(([key, label]) => (
                  <button key={key} onClick={() => switchTab(key)}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all"
                    style={tab === key ? { background: '#fff', color: '#0192F5', boxShadow: '0 2px 8px rgba(0,0,0,0.08)' } : { color: '#94a3b8' }}>
                    {label}
                  </button>
                ))}
              </div>

              {/* ── 입력 폼 ── */}
              <div className="space-y-3">
                <InputField label="이메일 주소" type="email" value={email} onChange={setEmail} placeholder="example@email.com" autoComplete="email" />
                <div>
                  <InputField
                    label={
                      <div className="flex items-center justify-between">
                        <span>비밀번호</span>
                        {tab === 'login' && (
                          <button type="button" onClick={openReset}
                            className="text-[11px] font-bold" style={{ color: '#0192F5' }}>
                            비밀번호 찾기
                          </button>
                        )}
                      </div>
                    }
                    type="password" value={password} onChange={setPassword}
                    placeholder={tab === 'login' ? '비밀번호 입력' : '6자 이상 입력'}
                    autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                  />
                  {tab === 'signup' && (
                    <p className="text-[11px] text-slate-400 mt-1.5 ml-1">6자 이상의 비밀번호를 사용해주세요</p>
                  )}
                </div>
                {error && <ErrorMsg msg={error} />}
                <SubmitBtn loading={loading} onClick={handleSubmit}
                  label={tab === 'login' ? '로그인' : '회원가입'} />
              </div>

              {/* ── 구분선 ── */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-slate-100" />
                <span className="text-[11px] text-slate-400 font-semibold">또는</span>
                <div className="flex-1 h-px bg-slate-100" />
              </div>

              {/* ── 게스트 ── */}
              <button onClick={onGuest}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-sm font-bold border border-slate-200 text-slate-500 bg-slate-50 active:scale-[0.98] transition-all">
                <Zap size={15} className="text-amber-400 fill-amber-400" />
                로그인 없이 둘러보기
              </button>
              <p className="text-center text-[11px] text-slate-400 -mt-2">게스트는 분석 기록이 저장되지 않아요</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 공용 InputField ─────────────────────────────────────────────────────────
function InputField({ label, type, value, onChange, placeholder, autoComplete }) {
  return (
    <div>
      {label && (
        typeof label === 'string'
          ? <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{label}</p>
          : <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{label}</div>
      )}
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} autoComplete={autoComplete}
        className="w-full px-4 py-3.5 rounded-2xl text-sm bg-slate-50 border border-slate-200 placeholder-slate-300 outline-none transition-all"
        onFocus={e => { e.target.style.borderColor = '#0192F5'; e.target.style.background = '#fff'; e.target.style.boxShadow = '0 0 0 3px rgba(1,146,245,0.08)' }}
        onBlur={e => { e.target.style.borderColor = '#e2e8f0'; e.target.style.background = '#f8fafc'; e.target.style.boxShadow = 'none' }}
      />
    </div>
  )
}
function ErrorMsg({ msg }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-red-50 border border-red-100">
      <XCircle size={14} className="text-red-400 shrink-0" />
      <p className="text-xs font-bold text-red-500">{msg}</p>
    </div>
  )
}
function SubmitBtn({ loading, onClick, label }) {
  return (
    <button onClick={onClick} disabled={loading}
      className="w-full flex items-center justify-center py-4 rounded-2xl text-sm font-extrabold text-white transition-all active:scale-[0.98] disabled:opacity-50"
      style={{ background: 'linear-gradient(135deg, #0192F5, #40BEFD)', boxShadow: '0 6px 20px rgba(1,146,245,0.30)' }}>
      {loading ? <Loader2 className="animate-spin" size={18} /> : label}
    </button>
  )
}

// ─── Groq API 호출 (지수 백오프) ─────────────────────────────────────────────
async function safeFetchGroq(body, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(GROQ_PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 401) throw new Error('API 키가 유효하지 않습니다.')
      if (res.status === 429 || res.status >= 500) {
        if (i < retries - 1) { await new Promise(r => setTimeout(r, delay * Math.pow(2, i))); continue }
      }
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `HTTP ${res.status}`) }
      return await res.json()
    } catch (e) {
      if (i === retries - 1) throw e
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i)))
    }
  }
}

// ─── DL 모델 추론 (결정적, 같은 사진 = 같은 결과) ────────────────────────────
async function fetchModelInference(base64WithPrefix) {
  try {
    console.log('🔬 DL 모델 호출 시작...')
    const res = await fetch(MODEL_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ image: base64WithPrefix }),
    })
    console.log(`🔬 DL 모델 응답: ${res.status}`)
    if (!res.ok) return null
    const data = await res.json()
    console.log('🔬 DL 모델 결과:', JSON.stringify(data).slice(0, 200))
    if (data.error || !data.success) return null
    return data
  } catch (e) {
    console.log('🔬 DL 모델 연결 실패:', e.message)
    return null
  }
}

// ─── DL 모델 멀티약 추론 (SAM 분리 → 각각 ArcFace) ─────────────────────────
async function fetchMultiPillInference(base64WithPrefix) {
  try {
    console.log('🔬 멀티약 SAM 분석 시작...')
    const res = await fetch(`${MODEL_PROXY}/multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({ image: base64WithPrefix }),
    })
    if (!res.ok) return null
    const data = await res.json()
    console.log('🔬 멀티약 결과:', JSON.stringify(data).slice(0, 300))
    if (data.error || !data.success) return null
    return data
  } catch (e) {
    console.log('🔬 멀티약 분석 실패:', e.message)
    return null
  }
}

// ─── 클라이언트 문장 자르기 (Groq 왕복 없이 즉시) ────────────────────────────
function trimToSentences(text, n = 2) {
  if (!text) return ''
  const t = String(text).trim()
  return t.split(/(?<=[.!?。])\s+/).slice(0, n).join(' ').trim()
}

// ─── 식약처 텍스트 AI 요약 (현재 미사용 — 클라이언트 자르기로 대체) ──────────────
async function summarizeMfdsText(label, text) {
  if (!text || text.length < 50) return text
  try {
    const data = await safeFetchGroq({
      model: GROQ_MODEL,
      messages: [{
        role: 'user',
        content: `다음 의약품 "${label}" 내용을 환자가 이해하기 쉽게 2문장 이내로 요약해주세요. 핵심만 간결하게:\n\n${text}`
      }],
      temperature: 0.3,
      max_tokens: 150,
    })
    return data.choices?.[0]?.message?.content?.trim() || text.slice(0, 100)
  } catch {
    return text.slice(0, 100)
  }
}

// ─── 타임아웃 fetch (식약처/DUR API가 죽어도 앱이 멈추지 않게) ────────────────
async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(id)
  }
}

// ─── 식약처 API: 의약품 개요정보 조회 ────────────────────────────────────────
async function fetchMfdsInfo(drugName) {
  if (!drugName) return null
  const parseMfdsItem = (item) => ({
    itemName: item.itemName,
    entpName: item.entpName,
    efcyQesitm: item.efcyQesitm,
    useMethodQesitm: item.useMethodQesitm,
    atpnWarnQesitm: item.atpnWarnQesitm,
    atpnQesitm: item.atpnQesitm,
    intrcQesitm: item.intrcQesitm,
    seQesitm: item.seQesitm,
    depositMethodQesitm: item.depositMethodQesitm,
    source: '식품의약품안전처',
  })
  const trySearch = async (name) => {
    const params = new URLSearchParams({ itemName: name, numOfRows: '3', pageNo: '1' })
    const res = await fetchWithTimeout(`${MFDS_DRUG_INFO_URL}&${params}`)
    const data = await res.json()
    const items = data?.body?.items
    if (!items || items.length === 0) return null
    return parseMfdsItem(items[0])
  }
  try {
    for (const variant of shortenDrugName(drugName)) {
      const result = await trySearch(variant)
      if (result) return result
    }
    return null
  } catch (e) {
    console.warn('식약처 API 오류:', e.message)
    return null
  }
}

function shortenDrugName(name) {
  const short = name.replace(/\(.*\)$/, '').trim()
  const base = name.replace(/(정|캡슐|밀리그램|mg|시럽|현탁액|산|과립|주)[\d]*.*$/i, '').trim()
  const variants = [name]
  if (short !== name) variants.push(short)
  if (base.length >= 2 && base !== name && base !== short) variants.push(base)
  return variants
}

// ─── 식약처 API: 낱알식별 - 이름으로 검색 ───────────────────────────────────
async function fetchPillByName(drugName) {
  if (!drugName) return null
  const trySearch = async (name) => {
    const params = new URLSearchParams({ itemName: name, numOfRows: '5', pageNo: '1' })
    const res = await fetchWithTimeout(`${MFDS_PILL_INFO_URL}&${params}`)
    const data = await res.json()
    const items = data?.body?.items
    if (!items || items.length === 0) return null
    return items[0]
  }
  try {
    for (const variant of shortenDrugName(drugName)) {
      const result = await trySearch(variant)
      if (result) return result
    }
    return null
  } catch (e) {
    console.warn('낱알식별(이름) API 오류:', e.message)
    return null
  }
}

// ─── 식약처 API: 낱알식별 - 색상/모양/각인으로 검색 ────────────────────────
async function fetchPillByFeature({ color, shape, imprint, form }) {
  try {
    const params = new URLSearchParams({ numOfRows: '3', pageNo: '1' })
    if (color) params.append('colorClass1', color)
    if (shape) params.append('chart', shape)
    if (imprint) params.append('markKorEng', imprint)
    if (form) params.append('formCodeName', form)
    const res = await fetchWithTimeout(`${MFDS_PILL_INFO_URL}&${params}`)
    const data = await res.json()
    const items = data?.body?.items
    if (!items || items.length === 0) return null
    return items[0]
  } catch (e) {
    console.warn('낱알식별 API 오류:', e.message)
    return null
  }
}

// ─── 식약처 API: 의약품 제품허가정보 상세 ────────────────────────────────────
function parseDocXml(xml) {
  if (!xml) return ''
  const texts = []
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].trim()
    if (t) texts.push(t)
  }
  return texts.join(' ').replace(/\s+/g, ' ').trim()
}

async function fetchDrugPermission(drugName) {
  if (!drugName) return null
  const parsePermitItem = (it) => {
    const eeDoc = parseDocXml(it.EE_DOC_DATA || it.eeDocData || '')
    const udDoc = parseDocXml(it.UD_DOC_DATA || it.udDocData || '')
    const nbDoc = parseDocXml(it.NB_DOC_DATA || it.nbDocData || '')
    return {
      itemName:       it.ITEM_NAME        || it.itemName        || null,
      entpName:       it.ENTP_NAME        || it.entpName        || null,
      itemPermitDate: it.ITEM_PERMIT_DATE || it.itemPermitDate  || null,
      ingrName:       it.INGR_NAME        || it.ingrName        || null,
      etcOtcName:     it.ETC_OTC_NAME     || it.etcOtcName      || null,
      storageMethod:  it.STORAGE_METHOD   || it.storageMethod   || null,
      validTerm:      it.VALID_TERM       || it.validTerm       || null,
      packUnit:       it.PACK_UNIT        || it.packUnit        || null,
      cancelName:     it.CANCEL_NAME      || it.cancelName      || null,
      eeDoc, udDoc, nbDoc,
      source: '식약처_제품허가',
    }
  }
  const trySearch = async (name) => {
    const params = new URLSearchParams({ item_name: name, numOfRows: '3', pageNo: '1' })
    const res = await fetchWithTimeout(`${MFDS_PRMISN_URL}&${params}`)
    if (!res.ok) return null
    const data = await res.json()
    const raw = data?.body?.items
    if (!raw) return null
    const items = Array.isArray(raw) ? raw : Array.isArray(raw.item) ? raw.item : [raw.item]
    if (!items || items.length === 0) return null
    return parsePermitItem(items[0])
  }
  try {
    for (const variant of shortenDrugName(drugName)) {
      const result = await trySearch(variant)
      if (result) return result
    }
    // 성분명으로 폴백 검색 (괄호 안 성분명 추출)
    const ingrMatch = drugName.match(/\(([^)]+)\)/)
    if (ingrMatch) {
      const fullIngr = ingrMatch[1]
      const result = await trySearch(fullIngr)
      if (result) return result
      const shortIngr = fullIngr.replace(/산.*$|염.*$/, '').trim()
      if (shortIngr.length >= 3 && shortIngr !== fullIngr) {
        const result2 = await trySearch(shortIngr)
        if (result2) return result2
      }
    }
    return null
  } catch (e) {
    console.warn('제품허가 API 오류:', e.message)
    return null
  }
}

// ─── DUR API 헬퍼 ────────────────────────────────────────────────────────────
async function fetchDurApi(endpoint, drugName) {
  if (!drugName) return []
  try {
    const params = new URLSearchParams({
      itemName: drugName,
      numOfRows: '5',
      pageNo: '1',
    })
    const res = await fetchWithTimeout(`${endpoint}&${params}`)
    if (!res.ok) return []
    const data = await res.json()
    const raw = data?.body?.items
    if (!raw) return []
    return Array.isArray(raw) ? raw : Array.isArray(raw.item) ? raw.item : raw.item ? [raw.item] : []
  } catch (e) {
    console.warn('DUR API 오류:', e.message)
    return []
  }
}

async function checkDurCombination(drugNames) {
  if (!drugNames || drugNames.length < 2) return []
  const warnings = []
  for (let i = 0; i < drugNames.length; i++) {
    for (let j = i + 1; j < drugNames.length; j++) {
      const drugA = drugNames[i], drugB = drugNames[j]
      const items = await fetchDurApi(DUR_ENDPOINTS.병용금기, drugA)
      const matched = items.filter(item => {
        const mixItem = item.MIXTURE_ITEM_NAME || item.mixtureItemName || ''
        const mixIngr = item.MIXTURE_INGR_KOR_NAME || item.mixtureIngrKorName || ''
        const mixIngrEng = item.MIXTURE_INGR_ENG_NAME || item.mixtureIngrEngName || ''
        return mixItem.includes(drugB) || drugB.includes(mixItem.slice(0, 4))
          || mixIngr.includes(drugB) || drugB.includes(mixIngr.slice(0, 2))
          || mixIngrEng.toLowerCase().includes(drugB.toLowerCase())
      })
      if (matched.length > 0) {
        const m = matched[0]
        const mixName = m.MIXTURE_INGR_KOR_NAME || m.mixtureIngrKorName || drugB
        const reason = m.PROHBT_CONTENT || m.prohibtContent || ''
        warnings.push({
          type: '병용금기', level: 'danger', drugs: [drugA, drugB],
          reason: reason ? `${drugA}와 ${mixName} 병용 시: ${reason.trim()}` : `${drugA}와 ${drugB}는 함께 복용하면 안 돼요.`,
          note: m.REMARK || m.remark || '',
        })
      }
    }
  }
  return warnings
}

async function checkDurPregnancy(drugNames) {
  const warnings = []
  for (const name of drugNames) {
    const items = await fetchDurApi(DUR_ENDPOINTS.임부금기, name)
    if (items.length > 0) {
      const item = items[0]
      warnings.push({
        type: '임부금기', level: 'danger', drugs: [name],
        reason: item.PROHBT_CONTENT || item.prohibtContent || `${name}은(는) 임산부가 복용하면 안 돼요.`,
        grade: item.PROHBT_GRADE || item.prohibtGrade || '',
        note: item.REMARK || item.remark || '',
      })
    }
  }
  return warnings
}

async function checkDurElderly(drugNames) {
  const warnings = []
  for (const name of drugNames) {
    const items = await fetchDurApi(DUR_ENDPOINTS.노인주의, name)
    if (items.length > 0) {
      const item = items[0]
      warnings.push({
        type: '노인주의', level: 'caution', drugs: [name],
        reason: item.ATENT_CONTENT || item.atentContent || `${name}은(는) 노인이 복용 시 주의가 필요해요.`,
        note: item.REMARK || item.remark || '',
      })
    }
  }
  return warnings
}

async function checkDurDuplicate(drugNames) {
  if (!drugNames || drugNames.length < 2) return []
  const warnings = []
  const efcyGroups = {}
  for (const name of drugNames) {
    const items = await fetchDurApi(DUR_ENDPOINTS.효능군중복, name)
    if (items.length > 0) {
      const code = items[0].EFCY_GROUP_NO || items[0].efcyGroupNo || null
      const groupName = items[0].EFCY_GROUP_NAME || items[0].efcyGroupName || null
      if (code) {
        if (!efcyGroups[code]) efcyGroups[code] = { groupName, drugs: [] }
        efcyGroups[code].drugs.push(name)
      }
    }
  }
  for (const [code, group] of Object.entries(efcyGroups)) {
    if (group.drugs.length >= 2) {
      warnings.push({
        type: '효능군중복', level: 'caution', drugs: group.drugs,
        reason: `${group.groupName || '동일 효능군'} 계열 약이 ${group.drugs.length}개예요. 중복 복용 주의!`,
        note: `효능군 코드: ${code}`,
      })
    }
  }
  return warnings
}

async function runDurCheck(pillResults, userProfile = {}) {
  const rawNames = pillResults.map(p => p.drugNameForSearch || p.summary).filter(Boolean)
  const drugNames = []
  for (const name of rawNames) {
    const norm = name.replace(/\s|\(.*\)/g, '').slice(0, 6)
    if (!drugNames.some(d => d.replace(/\s|\(.*\)/g, '').slice(0, 6) === norm)) drugNames.push(name)
  }
  if (drugNames.length === 0) return []
  const checks = []
  if (drugNames.length >= 2) {
    checks.push(checkDurCombination(drugNames))
    checks.push(checkDurDuplicate(drugNames))
  }
  checks.push(checkDurPregnancy(drugNames))
  checks.push(checkDurElderly(drugNames))

  // 약 부작용을 DUR 카드에 포함
  const pillWarnings = pillResults
    .filter(p => p.sideEffects && p.sideEffects.trim().length >= 10)
    .map(p => ({
      type: '부작용', level: 'info', drugs: [p.drugNameForSearch || p.summary],
      reason: p.sideEffects,
      note: '',
    }))
  const uniquePillWarnings = Object.values(pillWarnings.reduce((acc, w) => {
    if (!acc[w.drugs[0]]) acc[w.drugs[0]] = w
    return acc
  }, {}))

  const results = await Promise.all(checks)
  return [...results.flat(), ...uniquePillWarnings]
}

// ─── 알약 종합 분석 (병용 안전성 포함) ─────────────────────────────────────────
async function analyzePillsCombined(pillResults, symptom) {
  if (pillResults.length === 0) return null
  try {
    const pillSummary = pillResults.map((p, i) =>
      `${i+1}. 약품명: ${p.summary} | 성분: ${p.activeIngredients?.join(', ') || '알수없음'} | 효능: ${p.description}`
    ).join('\n')

    const interactionBlock = pillResults.length >= 2
      ? `\n\n### 병용 안전성 분석 (필수)\n다음을 반드시 분석하세요:\n1. 위 약들 사이에 병용 금기 또는 주의가 필요한 성분 조합이 있는가?\n2. 동일 계열(해열제+해열제 등) 또는 동일 성분 중복 복용 위험이 있는가?\n3. 심각한 상호작용(간독성, 출혈 위험, 혈압 변화 등)이 예상되는가?`
      : `\n\n### 성분 주의 분석\n이 약 안에 타 약물과 중복 복용 시 위험한 성분(예: 아세트아미노펜, NSAIDs)이 있는지 확인하세요.`

    const data = await safeFetchGroq({
      model: GROQ_MODEL,
      messages: [{
        role: 'system',
        content: '당신은 약물 상호작용 전문 AI 약사입니다. 병용 금기와 성분 중복에 대해 반드시 명확히 경고하세요. 쉬운 말로 설명하세요.'
      }, {
        role: 'user',
        content: `다음 약들을 분석해주세요:\n${pillSummary}\n\n사용자 증상: ${symptom || '없음'}${interactionBlock}\n\n아래 JSON만 반환하세요 (마크다운 금지):\n{\n  "combinedUse": "이 약들을 함께 먹는 이유 또는 각 용도 1-2문장",\n  "matchScore": "증상과 일치도 (높음/보통/낮음/알수없음)",\n  "matchReason": "증상과 맞는지 이유 1문장",\n  "recommendation": "추천합니다 | 주의가 필요해요 | 확인이 필요해요",\n  "recommendCode": "safe | caution | danger",\n  "oneLineSummary": "20자 이내 핵심 한줄 요약",\n  "drugInteractions": [\n    {\n      "level": "danger | caution | info",\n      "drugs": ["약A이름", "약B이름"],\n      "reason": "위험 이유 (예: 아세트아미노펜 중복 → 간 손상 위험)",\n      "advice": "사용자 권고 행동 1문장"\n    }\n  ]\n}\n\n상호작용이 없으면 drugInteractions는 빈 배열 []로 반환하세요.`
      }],
      temperature: 0.2,
      max_tokens: 600,
    })
    const raw = data.choices?.[0]?.message?.content || '{}'
    return JSON.parse(raw.replace(/```json|```/g, '').trim())
  } catch (e) {
    console.warn('종합 분석 실패:', e.message)
    return null
  }
}

// ─── 알약 1개 전체 분석 ───────────────────────────────────────────────────────
async function analyzeSinglePill(pillFeature, symptomHint) {
  let pillData = null
  let matchSource = 'none'
  let drugInfo = null
  let permitInfo = null

  // DL 모델이 약 이름을 줬으면 → drugInfo 먼저, 없으면 pillInfo 폴백
  if (pillFeature.fromDL && pillFeature.drugName?.trim()) {
    const dlName = pillFeature.drugName.trim()
    ;[drugInfo, permitInfo] = await Promise.all([
      fetchMfdsInfo(dlName),
      fetchDrugPermission(dlName),
    ])
    if (drugInfo) {
      matchSource = 'dl_name'
      pillData = { itemName: drugInfo.itemName || dlName, entpName: drugInfo.entpName }
    }
    // drugInfo에 없으면 → pillInfo(낱알식별)로 폴백
    if (!pillData) {
      pillData = await fetchPillByName(dlName)
      if (pillData) {
        matchSource = 'dl_name'
        // pillData에서 이름 찾았으면 drugInfo/permission 재시도
        const pillItemName = pillData.itemName || pillData.ITEM_NAME
        if (pillItemName) {
          const [di, pi] = await Promise.all([
            fetchMfdsInfo(pillItemName),
            fetchDrugPermission(pillItemName),
          ])
          if (di) drugInfo = di
          if (pi) permitInfo = pi
        }
      }
    }
  }

  // DL 결과 없거나 둘 다 못 찾으면 기존 로직
  if (!pillData) {
    // 1단계: Vision이 약 이름 읽었으면 이름으로 먼저 검색
    if (pillFeature.drugName && pillFeature.drugName.trim().length > 0) {
      pillData = await fetchPillByName(pillFeature.drugName.trim())
      if (pillData) matchSource = 'name'
      if (!pillData && pillFeature.imprint && pillFeature.imprint.trim().length > 0) {
        pillData = await fetchPillByName(pillFeature.imprint.trim())
        if (pillData) matchSource = 'imprint'
      }
    }

    // 2단계: 각인 단독 검색
    if (!pillData && pillFeature.imprint && pillFeature.imprint.trim().length > 0) {
      pillData = await fetchPillByName(pillFeature.imprint.trim())
      if (pillData) matchSource = 'imprint'
    }

    // 3단계: 색상/모양으로 fallback
    if (!pillData) {
      pillData = await fetchPillByFeature({
        color: pillFeature.color,
        shape: pillFeature.shape,
        imprint: pillFeature.imprint,
        form: pillFeature.form,
      })
      if (pillData) matchSource = 'feature'
    }

    // 4단계: 약품명으로 개요 + 제품허가 병렬 조회
    const resolvedName = pillData?.itemName || pillData?.ITEM_NAME
    if (resolvedName && !drugInfo) {
      const [di, pi] = await Promise.all([
        fetchMfdsInfo(resolvedName),
        fetchDrugPermission(resolvedName),
      ])
      if (di) drugInfo = di
      if (pi) permitInfo = pi
    }
  }

  if (pillData) {
    let efcySummary = drugInfo?.efcyQesitm || ''
    let atpnSummary = drugInfo?.atpnQesitm || ''
    let useSummary  = drugInfo?.useMethodQesitm || ''
    let sideEffects = drugInfo?.seQesitm || ''
    // 작업2: Groq 요약 제거 → 클라이언트에서 앞 문장만 자르기 (왕복 0초, 원문 보존은 별도 필드)
    const efcyFull = efcySummary, atpnFull = atpnSummary, useFull = useSummary
    efcySummary = trimToSentences(efcySummary, 2)
    atpnSummary = trimToSentences(atpnSummary, 3)
    useSummary  = trimToSentences(useSummary, 2)

    // drugInfo 없으면 제품허가 EE/UD/NB 데이터로 폴백
    if (!efcySummary && permitInfo?.eeDoc) efcySummary = trimToSentences(permitInfo.eeDoc, 2)
    if ((!useSummary || useSummary === '-') && permitInfo?.udDoc) useSummary = trimToSentences(permitInfo.udDoc, 2)
    if (!atpnSummary && permitInfo?.nbDoc) atpnSummary = trimToSentences(permitInfo.nbDoc, 3)

    // drugInfo도 제품허가도 없으면 Groq AI 폴백
    const pillName = pillData.itemName || pillData.ITEM_NAME
    const className = pillData.CLASS_NAME || ''
    const etcOtcRaw = pillData.ETC_OTC_NAME || permitInfo?.etcOtcName || ''
    const isPrescription = etcOtcRaw.includes('전문')
    // 작업3: Groq 정보채우기 폴백 제거 — "이 나타날 수 있습니다" 같은 깨진 조각 차단 + 속도↑
    // (효능/복용법/주의사항/부작용은 식약처 실데이터만 사용, 없으면 아래 분류/처방약 기본문구)
    if (!efcySummary && className) {
      const classEfcyMap = {
        '해열진통소염제': '열을 내리고 통증을 완화하며 염증을 가라앉히는 데 효과가 있습니다.',
        '소화기관용약': '소화불량, 위장장애, 구역, 구토 등 소화기 증상 개선에 효과가 있습니다.',
        '항히스타민제': '알레르기 증상(재채기, 콧물, 가려움 등)을 완화하는 데 효과가 있습니다.',
        '진해거담제': '기침을 가라앉히고 가래를 삭이는 데 효과가 있습니다.',
        '항생물질제제': '세균 감염을 치료하는 항생제입니다.',
        '혈압강하제': '높은 혈압을 낮추는 데 효과가 있습니다.',
        '혈당강하제': '혈당을 조절하여 당뇨병 치료에 사용됩니다.',
        '정신신경용제': '불안, 우울, 불면 등 정신신경계 증상 완화에 사용됩니다.',
        '순환계용약': '혈액순환 개선에 효과가 있습니다.',
      }
      const matched = Object.entries(classEfcyMap).find(([k]) => className.includes(k))
      efcySummary = matched ? matched[1] : `${className} 계열 의약품입니다.`
    }
    if (isPrescription) {
      if (!useSummary || useSummary === '-') useSummary = '전문의약품(처방약)으로, 의사의 처방에 따라 복용하세요.'
      if (atpnSummary) atpnSummary = `이 약은 전문의약품(처방약)입니다. ${atpnSummary}`
      else atpnSummary = '이 약은 전문의약품(처방약)이므로 반드시 의사의 처방을 받아 복용하세요.'
    }
    if (!atpnSummary) atpnSummary = '복용 전 약사에게 확인하세요.'

    const etcOtc = permitInfo?.etcOtcName || pillData.ETC_OTC_NAME || (drugInfo ? '처방약' : '-')
    return {
      statusCode: 'caution',
      statusText: '복용 전 확인하세요',
      summary: pillName || pillFeature.drugName || `${pillFeature.color} ${pillFeature.shape} 알약`,
      drugNameForSearch: pillName,
      description: efcySummary || '',
      className: className || '',
      isPrescription,
      visualDescription: `${pillFeature.color}색 ${pillFeature.shape} 알약이에요.`,
      warnings: atpnSummary || '복용 전 약사에게 확인하세요.',
      sideEffects: sideEffects || '',
      dosageGuide: useSummary || '-',
      interactions: drugInfo?.intrcQesitm ? [drugInfo.intrcQesitm.slice(0, 60)] : [],
      activeIngredients: permitInfo?.ingrName ? [permitInfo.ingrName] : pillName ? [pillName] : [],
      drugType:      etcOtc,
      confidence:    calculateMatchConfidence({ pillFeature, matchSource, drugInfo, permitInfo }),
      matchSource,
      pillColor:     pillFeature.color,
      pillShape:     pillFeature.shape,
      pillImprint:   pillFeature.imprint,
      itemImage:     pillData?.itemImage    || pillData?.ITEM_IMAGE || null,
      entpName:      permitInfo?.entpName   || pillData?.entpName || pillData?.ENTP_NAME || null,
      permitDate:    permitInfo?.itemPermitDate || null,
      storageMethod: permitInfo?.storageMethod  || null,
      validTerm:     permitInfo?.validTerm      || null,
      packUnit:      permitInfo?.packUnit       || null,
      cancelName:    permitInfo?.cancelName     || null,
      mfdsFound:     true,
      permitFound:   !!permitInfo,
    }
  }

  return {
    statusCode:  'caution',
    statusText:  '식약처 DB 미등록',
    summary:     pillFeature.drugName || `${pillFeature.color} ${pillFeature.shape} 알약`,
    description: '',
    visualDescription: `${pillFeature.color}색 ${pillFeature.shape} 알약이에요. ${pillFeature.imprint ? `각인: ${pillFeature.imprint}` : '각인 없음'}`,
    warnings:    '식약처 DB에서 찾을 수 없어요. 처방한 의사/약사에게 확인하세요.',
    dosageGuide: '-',
    interactions: [],
    activeIngredients: [],
    drugType:    '-',
    confidence:  0.2,
    matchSource: 'none',
    pillColor:   pillFeature.color,
    pillShape:   pillFeature.shape,
    pillImprint: pillFeature.imprint,
    mfdsFound:   false,
    permitFound: false,
  }
}

// ─── AI Vision 프롬프트 ───────────────────────────────────────────────────────
const buildVisionPrompt = (userConditions, symptom) => `
당신은 약학 전문가 + 이미지 분석 전문가입니다. 이미지 속 알약을 정밀 분석하세요.

## 분석 순서 (반드시 이 순서대로)

### STEP 1. 각인/표면 텍스트 읽기
알약 표면의 숫자, 영문, 한글을 정확히 읽으세요.
예시: TYLENOL, 500, ER, TL, 게보린, 펜잘 등

### STEP 2. 외형 특징 추출
색상, 모양, 제형, 크기를 아래 식약처 기준 단어로 추출하세요.
(색상/모양은 반드시 아래 허용 단어만 사용)

## 색상 (이 단어만 허용)
하양, 노랑, 주황, 분홍, 빨강, 갈색, 연두, 초록, 청록, 파랑, 남색, 보라, 회색, 검정, 투명

## 모양 (이 단어만 허용)
원형, 타원형, 장방형, 삼각형, 사각형, 마름모형, 오각형, 육각형, 팔각형, 기타

## 제형
정제, 경질캡슐, 연질캡슐, 필름코팅정

### STEP 3. 약 이름 종합 추론 (핵심!)
STEP1 + STEP2에서 수집한 모든 정보를 종합해서 이 알약이 어떤 약인지 추론하세요.

종합 근거:
- STEP1 각인 텍스트
- STEP2 색상 + 모양 + 제형 + 크기 조합
- 사용자 증상: ${symptom || '없음'}
- 기저질환: ${userConditions || '없음'}

추론 예시:
- 각인 "TYLENOL 500" + 하양 원형 → drugName: "타이레놀"
- 각인 "500" + 하양 원형 + 증상 두통 → drugName: "타이레놀500mg 추정"
- 각인 없음 + 분홍 타원형 + 증상 소화불량 → drugName: "소화제 계열 추정"
- 각인 없음 + 추론 불가 → drugName: ""

JSON만 반환 (마크다운/설명 절대 금지):
{
  "pills": [
    {
      "drugName": "STEP3에서 추론한 약 이름 (예: 타이레놀, 게보린, 소화제 계열 추정 / 추론 불가면 빈 문자열)",
      "color": "색상 (식약처 기준 단어만)",
      "shape": "모양 (식약처 기준 단어만)",
      "form": "제형",
      "imprint": "각인 문자 전체 (없으면 빈 문자열)",
      "size": "크기 (소/중/대)",
      "confidence": 0.0부터 1.0까지의 이미지 식별 확신도,
      "description": "외형 + 추론 근거 1문장 (예: 하양 원형 정제, 각인 TYLENOL 500으로 타이레놀로 추정)"
    }
  ],
  "totalCount": 알약_개수,
  "symptomHint": "증상 기반 예상 약품 종류 (예: 해열진통제, 소화제)"
}

알약이 안 보이면: {"pills": [], "totalCount": 0, "symptomHint": ""}
`

// ─── 채팅 시스템 프롬프트 (신뢰도 3케이스) ───────────────────────────────────
const buildChatSystemPrompt = (analysisResult, mfdsInfo, userConditions) => {
  const pct = Math.round((analysisResult?.confidence || 0) * 100)
  const drugName = analysisResult?.summary || '미분석'

  const langRule = '반드시 한국어로만 답변하세요. 영어, 한자(漢字), 베트남어 등 외국어를 절대 섞지 마세요. 성분명·학명도 한글로 표기하세요.'

  const highConfidencePrompt = `
당신은 식약처 공공 데이터를 기반으로 의약품 정보를 설명하는 '의약품 정보 분석 전문가'입니다.
${langRule}
AI는 약물의 종류를 식별할 뿐 복용, 처방, 치료 적합성 판단을 하지 않습니다.
모든 설명의 근거는 식약처 공식 허가 데이터입니다.

[응답 원칙]
1. "먹어도 된다/먹으면 안 된다/처방이 맞다" 같은 복용 판단을 하지 않습니다.
2. 사용자가 "이 약이 [질환명] 약이 맞나요?" 라고 물으면 식약처 허가 데이터상 해당 질환 또는 증상 치료 목적으로 승인된 정보가 있는지 여부만 답합니다.
3. 성분, 효능, 용법, 주의사항은 식약처 데이터에 있는 내용만 근거로 설명합니다.
4. 답변은 아래 템플릿 구조로 출력합니다:

[식약처 데이터 분석 결과]
의약품 명칭: {약 이름}
공식 허가 용도: 식약처 데이터 기준 {승인된 효능/효과}
주요 작용:
  • [성분 A]: [신체 작용 설명]
  • [성분 B]: [신체 작용 설명]
판단 범위: AI 복용 판단이 아니라 식약처 데이터 대조 결과입니다.

현재 분석된 약품: ${drugName}
사용자 기저질환: ${userConditions || '없음'}
${mfdsInfo ? `\n식품의약품안전처 공식 정보:\n- 효능: ${mfdsInfo.efcyQesitm || '-'}\n- 복용법: ${mfdsInfo.useMethodQesitm || '-'}\n- 주의사항: ${mfdsInfo.atpnQesitm || '-'}\n- 부작용: ${mfdsInfo.seQesitm || '-'}` : ''}
`

  const midConfidencePrompt = `
당신은 식약처 공공 데이터를 기반으로 의약품 정보를 매칭해주는 '의약품 정보 분석 전문가'입니다.
${langRule}
현재 분석 일치율은 ${pct}%로 중간 수준입니다.

[응답 원칙]
1. 모든 답변에 "식약처 데이터베이스와 ${pct}% 일치하는 의약품 정보"임을 명시합니다.
2. 정보를 제공할 때 "데이터 매칭 결과"임을 강조하고, 복용 판단은 하지 않습니다.
3. 답변 말미에 항상 아래 주의 문구를 포함합니다:
   "[주의] 분석 일치율이 70% 미만인 경우, 사진 상태에 따라 정보 왜곡이 발생할 수 있습니다. 본 앱은 AI의 복용 판단이 아니라 식약처 데이터 대조 결과만 제공합니다. 실제 약품 외형을 반드시 다시 확인하십시오."

현재 분석된 약품: ${drugName} (일치율 ${pct}%)
사용자 기저질환: ${userConditions || '없음'}
${mfdsInfo ? `\n식품의약품안전처 공식 정보:\n- 효능: ${mfdsInfo.efcyQesitm || '-'}\n- 복용법: ${mfdsInfo.useMethodQesitm || '-'}\n- 주의사항: ${mfdsInfo.atpnQesitm || '-'}` : ''}
`

  const lowConfidencePrompt = `
당신은 식약처 공공 데이터를 기반으로 의약품 정보를 매칭해주는 '의약품 정보 분석 전문가'입니다.
${langRule}
현재 분석 일치율은 ${pct}%로 안전한 정보 제공이 어렵습니다.

[응답 원칙]
1. 약품 정보를 직접 제공하지 않습니다.
2. 모든 질문에 대해 아래와 같이 안내합니다:
   "현재 데이터 일치율이 현저히 낮아(${pct}%), 잘못된 정보 제공으로 인한 약물 오남용 위험이 감지되었습니다. 사용자의 안전을 최우선으로 하여 분석 결과를 제공하지 않습니다."
3. 대신 아하 게시판 약사 상담을 권유합니다: https://www.a-ha.io/topic/%EC%95%BD%EC%98%81%EC%96%91%EC%A0%9C/%EC%95%BD%EB%B3%B5%EC%9A%A9?order=answerRegistration
`

  if (pct >= 80) return highConfidencePrompt
  if (pct >= 50) return midConfidencePrompt
  return lowConfidencePrompt
}

// ─── 상태 매핑 ────────────────────────────────────────────────────────────────
const STATUS_MAP = {
  safe: { icon: CheckCircle, bg: 'bg-green-50', border: 'border-emerald-200', text: 'text-emerald-700', badge: 'bg-green-100 text-emerald-800', label: '복용 가능' },
  caution: { icon: AlertTriangle, bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-800', label: '주의 필요' },
  danger: { icon: XCircle, bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', badge: 'bg-red-100 text-red-800', label: '복용 위험' },
  unidentified: { icon: XCircle, bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-600', badge: 'bg-slate-100 text-slate-700', label: '인식 불가' },
}

const COMMUNITY_URL = 'https://www.a-ha.io/topic/%EC%95%BD%EC%98%81%EC%96%91%EC%A0%9C/%EC%95%BD%EB%B3%B5%EC%9A%A9?order=answerRegistration'

const getConfidencePct = (confidence) => {
  const raw = Number(confidence || 0)
  const pct = raw <= 1 ? raw * 100 : raw
  return Math.max(0, Math.min(100, Math.round(pct)))
}

const getConfidenceBand = (confidence) => {
  const pct = getConfidencePct(confidence)
  if (pct < 50) return 'blocked'
  if (pct < 70) return 'low'
  return 'usable'
}

const calculateMatchConfidence = ({ pillFeature, matchSource, drugInfo, permitInfo }) => {
  let score = 100

  // 식별/DB 매칭은 성공한 상태에서 환경적 불확실성만 차감한다.
  if (matchSource === 'feature') score -= 10
  else if (matchSource === 'imprint') score -= 5

  if (!pillFeature?.imprint) score -= 5
  if (!pillFeature?.drugName) score -= 3
  if (!drugInfo) score -= 5
  if (!permitInfo) score -= 3

  const aiPct = getConfidencePct(pillFeature?.confidence)
  if (aiPct > 0) {
    if (aiPct < 65) score -= 10
    else if (aiPct < 80) score -= 5
    else if (aiPct < 90) score -= 3
  }

  return Math.max(50, Math.min(99, score)) / 100
}

function DisclaimerBar() {
  return (
    <p className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] text-center text-[13px] text-slate-400 bg-white/80 backdrop-blur-sm py-2 z-40 leading-snug pointer-events-none">
      AI 정보는 참고용입니다 · 전문의 판단이 우선합니다
    </p>
  )
}

function CommunityButton({ label = '약사 커뮤니티에 물어보기' }) {
  return (
    <a
      href={COMMUNITY_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-[#2563eb] text-white text-sm font-black shadow-sm shadow-blue-100 active:scale-95 transition-transform"
    >
      <MessageCircle size={16} /> {label}
    </a>
  )
}

// ─── AI 약물 상호작용 경고 카드 ──────────────────────────────────────────────
function InteractionAlertCard({ interactions }) {
  if (!interactions || interactions.length === 0) return null
  const LEVEL_STYLE = {
    danger:  { bg: 'bg-red-50',   border: 'border-red-400',   badge: 'bg-red-100 text-red-700',    icon: '🚫', label: '병용 금지' },
    caution: { bg: 'bg-amber-50', border: 'border-amber-400', badge: 'bg-amber-100 text-amber-700',icon: '⚠️', label: '주의 필요' },
    info:    { bg: 'bg-blue-50',  border: 'border-blue-300',  badge: 'bg-blue-100 text-blue-700',  icon: 'ℹ️', label: '참고' },
  }
  const topLevel = interactions.some(i => i.level === 'danger') ? 'danger' : interactions.some(i => i.level === 'caution') ? 'caution' : 'info'
  const topStyle = LEVEL_STYLE[topLevel]
  return (
    <div className={`rounded-3xl border-2 ${topStyle.border} overflow-hidden animate-slide-up`}>
      <div className={`px-4 py-3 flex items-center gap-2 ${topLevel === 'danger' ? 'bg-red-500' : topLevel === 'caution' ? 'bg-amber-500' : 'bg-blue-500'}`}>
        <span className="text-lg">{topStyle.icon}</span>
        <p className="text-white font-black text-sm flex-1">
          {topLevel === 'danger' ? '⛔ 약물 상호작용 위험 감지!' : topLevel === 'caution' ? '⚠️ 약물 상호작용 주의' : '💡 약물 복용 참고사항'}
        </p>
        <span className="text-xs text-white/80 bg-white/20 px-2 py-0.5 rounded-full font-bold">{interactions.length}건</span>
      </div>
      <div className="divide-y divide-slate-100">
        {interactions.map((item, i) => {
          const s = LEVEL_STYLE[item.level] || LEVEL_STYLE.caution
          return (
            <div key={i} className={`px-4 py-3 ${s.bg} space-y-1.5`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.badge}`}>{s.label}</span>
                {item.drugs?.map((d, j) => (
                  <span key={j} className="text-xs font-bold text-slate-700 bg-white px-2 py-0.5 rounded-full border border-slate-200">{d}</span>
                ))}
              </div>
              <p className="text-sm font-semibold text-slate-800">{item.reason}</p>
              {item.advice && <p className="text-xs text-slate-500 leading-snug">{item.advice}</p>}
            </div>
          )
        })}
      </div>
      <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100">
        <p className="text-[10px] text-slate-400 leading-snug">※ AI 분석 결과입니다. 복용 전 약사 또는 의사에게 반드시 확인하세요.</p>
      </div>
    </div>
  )
}

// ─── DUR 경고 카드 ────────────────────────────────────────────────────────────
function DurWarningCard({ warnings }) {
  if (!warnings || warnings.length === 0) return null
  const TYPE_STYLE = {
    병용금기:   { bg: 'bg-red-50',    border: 'border-red-200',    badge: 'bg-red-100 text-red-700',    icon: '🚫' },
    임부금기:   { bg: 'bg-pink-50',   border: 'border-pink-200',   badge: 'bg-pink-100 text-pink-700',  icon: '🤰' },
    노인주의:   { bg: 'bg-amber-50',  border: 'border-amber-200',  badge: 'bg-amber-100 text-amber-700',icon: '👴' },
    효능군중복: { bg: 'bg-orange-50', border: 'border-orange-200', badge: 'bg-orange-100 text-orange-700', icon: '⚠️' },
    부작용:     { bg: 'bg-purple-50', border: 'border-purple-200', badge: 'bg-purple-100 text-purple-700', icon: '⚠️' },
  }
  return (
    <div className="space-y-3 animate-slide-up">
      <p className="text-xs font-bold text-red-400 uppercase tracking-wide px-1 flex items-center gap-1">
        <span>🛡️</span> DUR 안전성 정보 {warnings.length}건
      </p>
      {warnings.map((w, i) => {
        const s = TYPE_STYLE[w.type] || TYPE_STYLE['효능군중복']
        return (
          <div key={i} className={`rounded-2xl border-2 ${s.border} ${s.bg} p-4 space-y-2`}>
            <div className="flex items-center gap-2">
              <span className="text-lg">{s.icon}</span>
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${s.badge}`}>{w.type}</span>
              <span className="text-xs text-slate-500">{w.drugs.join(' + ')}</span>
            </div>
            <p className="text-sm font-semibold text-slate-800">{w.reason}</p>
            {w.note ? <p className="text-xs text-slate-400">{w.note}</p> : null}
          </div>
        )
      })}
    </div>
  )
}

// ─── 정정하기 모달 (팀원 테스트용 — Active Learning 데이터 수집) ──────────────
function CorrectionModal({ isOpen, onClose, currentImage, currentResult, allPillResults, initialIdx = -1, onSubmit }) {
  const [editingIdx, setEditingIdx] = useState(initialIdx)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [selectedName, setSelectedName] = useState('')
  const [customName, setCustomName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submittedSet, setSubmittedSet] = useState(new Set())

  if (!isOpen) return null

  const pills = allPillResults?.length > 0 ? allPillResults : currentResult ? [currentResult] : []
  const isMulti = pills.length > 1
  const editingPill = editingIdx >= 0 ? pills[editingIdx] : null
  const allDone = pills.length > 0 && submittedSet.size === pills.length

  const resetForm = () => {
    setSearchQuery('')
    setSearchResults([])
    setSelectedName('')
    setCustomName('')
  }

  const searchMfds = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const res = await fetch(`${MFDS_PROXY}?endpoint=drugInfo&itemName=${encodeURIComponent(searchQuery.trim())}`)
      if (res.ok) {
        const data = await res.json()
        const items = data?.body?.items || []
        const list = Array.isArray(items) ? items : [items]
        setSearchResults(list.filter(it => it?.itemName).slice(0, 10))
      } else {
        setSearchResults([])
      }
    } catch { setSearchResults([]) }
    setSearching(false)
  }

  const handleSubmit = async () => {
    const correctName = selectedName || customName.trim()
    if (!correctName) return
    const pill = editingPill || currentResult
    setSubmitting(true)
    try {
      await onSubmit({
        correctDrugName: correctName,
        originalResult: pill?.summary || '미인식',
        originalConfidence: pill?.confidence || 0,
        image: currentImage,
        pillIndex: editingIdx >= 0 ? editingIdx : 0,
      })
      setSubmittedSet(prev => new Set([...prev, editingIdx >= 0 ? editingIdx : 0]))
      if (isMulti) {
        setEditingIdx(-1)
        resetForm()
      }
    } catch (e) { console.warn('정정 저장 실패:', e.message) }
    setSubmitting(false)
  }

  if (!isMulti && submittedSet.size > 0) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/50 flex items-end justify-center" onClick={onClose}>
        <div className="w-full max-w-[480px] bg-white rounded-t-3xl p-6 space-y-4 animate-slide-up" onClick={e => e.stopPropagation()}>
          <div className="text-center space-y-2">
            <span className="text-5xl">✅</span>
            <p className="font-bold text-lg text-slate-800">정정 완료!</p>
            <p className="text-sm text-slate-500">학습 데이터에 반영됩니다. 감사합니다!</p>
          </div>
          <button onClick={onClose} className="w-full py-3 rounded-2xl bg-slate-100 text-slate-600 font-bold">닫기</button>
        </div>
      </div>
    )
  }

  if (isMulti && editingIdx < 0) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/50 flex items-end justify-center" onClick={onClose}>
        <div className="w-full max-w-[480px] bg-white rounded-t-3xl p-5 space-y-4 animate-slide-up max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
          <div className="text-center">
            <p className="font-bold text-lg text-slate-800">🔧 약 이름 정정하기</p>
            <p className="text-xs text-slate-400 mt-1">정정할 약을 선택하세요</p>
          </div>
          <div className="space-y-2">
            {pills.map((pill, i) => (
              <button
                key={i}
                onClick={() => { resetForm(); setEditingIdx(i) }}
                className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-all flex items-center justify-between ${
                  submittedSet.has(i) ? 'border-green-200 bg-green-50' : 'border-slate-200 bg-white active:bg-slate-50'
                }`}
              >
                <div>
                  <p className="font-bold text-slate-800">{pill.summary || `알약 ${i + 1}`}</p>
                  <p className="text-xs text-slate-400">{pill.confidence ? `${pill.confidence}%` : ''} {pill.entpName || ''}</p>
                </div>
                {submittedSet.has(i)
                  ? <span className="text-green-500 text-sm font-bold">정정됨 ✓</span>
                  : <span className="text-amber-500 text-sm">정정하기 →</span>
                }
              </button>
            ))}
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-500 font-bold text-sm">
              {allDone ? '완료' : '닫기'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black/50 flex items-end justify-center" onClick={onClose}>
      <div className="w-full max-w-[480px] bg-white rounded-t-3xl p-5 space-y-4 animate-slide-up max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="text-center">
          <p className="font-bold text-lg text-slate-800">🔧 약 이름 정정하기</p>
          <p className="text-xs text-slate-400 mt-1">AI가 잘못 인식했다면 올바른 약 이름을 알려주세요</p>
        </div>

        {(editingPill || currentResult)?.summary && (
          <div className="bg-red-50 rounded-xl p-3 border border-red-100">
            <p className="text-xs text-red-400 font-semibold">AI 분석 결과{isMulti ? ` (${editingIdx + 1}번째 약)` : ''}</p>
            <p className="text-sm font-bold text-red-700">{(editingPill || currentResult).summary}</p>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-500">식약처 DB에서 검색</p>
          <div className="flex gap-2">
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && searchMfds()}
              placeholder="약 이름 입력 (예: 타이레놀)"
              className="flex-1 px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-blue-400"
            />
            <button onClick={searchMfds} disabled={searching} className="px-4 py-2.5 rounded-xl bg-[#0192F5] text-white text-sm font-bold shrink-0 disabled:opacity-50">
              {searching ? '...' : '검색'}
            </button>
          </div>
        </div>

        {searchResults.length > 0 && (
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {searchResults.map((item, i) => (
              <button
                key={i}
                onClick={() => { setSelectedName(item.itemName); setCustomName('') }}
                className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm transition-all ${
                  selectedName === item.itemName ? 'border-blue-400 bg-blue-50 font-bold text-blue-700' : 'border-slate-100 bg-slate-50 text-slate-700'
                }`}
              >
                <p className="font-semibold truncate">{item.itemName}</p>
                {item.entpName && <p className="text-xs text-slate-400">{item.entpName}</p>}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-500">또는 직접 입력</p>
          <input
            value={customName}
            onChange={e => { setCustomName(e.target.value); setSelectedName('') }}
            placeholder="정확한 약 이름을 입력하세요"
            className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-blue-400"
          />
        </div>

        <div className="flex gap-2 pt-2">
          {isMulti && (
            <button onClick={() => { setEditingIdx(-1); resetForm() }} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-500 font-bold text-sm">← 목록</button>
          )}
          {!isMulti && (
            <button onClick={onClose} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-500 font-bold text-sm">취소</button>
          )}
          <button
            onClick={handleSubmit}
            disabled={submitting || (!selectedName && !customName.trim())}
            className="flex-[2] py-3 rounded-2xl bg-gradient-to-r from-[#0192F5] to-[#40BEFD] text-white font-bold text-sm disabled:opacity-40"
          >
            {submitting ? '저장 중...' : '정정 제출'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 알약 리스트 카드 ─────────────────────────────────────────────────────────
function PillListCard({ pillResults, onSelectPill, selectedIdx, onCorrectPill }) {
  if (!pillResults || pillResults.length === 0) return null
  return (
    <div className="space-y-3 animate-slide-up">
      <p className="text-xs font-bold text-slate-400 uppercase tracking-wide px-1">
        분석된 알약 {pillResults.length}개
      </p>
      {pillResults.map((pill, i) => {
        const s = STATUS_MAP[pill.statusCode] || STATUS_MAP.caution
        const StatusIcon = s.icon
        const isSelected = selectedIdx === i
        const confidencePct = getConfidencePct(pill.confidence)
        const confidenceBand = getConfidenceBand(pill.confidence)
        const isBlocked = confidenceBand === 'blocked'
        const needsCommunity = confidenceBand === 'low'
        const confidenceStyle = isBlocked
          ? 'bg-red-100 text-red-700'
          : needsCommunity
            ? 'bg-amber-100 text-amber-700'
            : 'bg-blue-100 text-blue-700'
        return (
          <div
            key={i}
            className={`w-full rounded-2xl border-2 p-4 transition-all ${isSelected ? `${isBlocked ? 'border-red-300 bg-red-50 shadow-sm shadow-red-100' : needsCommunity ? 'border-amber-200 bg-amber-50' : `${s.border} ${s.bg}`}` : 'border-slate-100 bg-white'}`}
          >
            <button type="button" onClick={() => onSelectPill(i)} className="w-full text-left flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-lg"
                style={{ background: pill.pillColor === '하양' ? '#f1f5f9' : pill.pillColor === '분홍' ? '#fce7f3' : pill.pillColor === '파랑' ? '#dbeafe' : pill.pillColor === '노랑' ? '#fef9c3' : pill.pillColor === '연두' ? '#dcfce7' : '#f1f5f9' }}>
                💊
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className={`font-bold text-sm truncate ${isBlocked ? 'text-red-800' : 'text-slate-800'}`}>{isBlocked ? '분석 결과 미표시' : pill.summary}</p>
                  {!isBlocked && pill.mfdsFound && <span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-full font-semibold shrink-0">식약처</span>}
                </div>
                <p className={`text-xs mt-0.5 ${isBlocked ? 'text-red-400' : 'text-slate-400'}`}>{pill.pillColor} · {pill.pillShape}{pill.pillImprint ? ` · 각인: ${pill.pillImprint}` : ''}{!isBlocked && pill.entpName ? ` · ${pill.entpName}` : ''}</p>
                <p className={`text-xs mt-1 line-clamp-2 ${isBlocked ? 'text-red-600' : 'text-slate-500'}`}>
                  {isBlocked ? '사용자 안전을 위해 약 정보를 표시하지 않습니다.' : (pill.description || pill.visualDescription || '식약처 효능 데이터 없음')}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className={`text-xs font-black px-2 py-1 rounded-full ${isBlocked ? 'bg-red-100 text-red-700' : confidenceStyle}`}>{confidencePct}%</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isBlocked ? 'bg-red-200 text-red-800' : s.badge}`}>
                  {isBlocked ? '차단' : pill.mfdsFound ? '확인됨' : '미확인'}
                </span>
              </div>
            </button>
            {isSelected && (
              <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                {isBlocked ? (
                  <>
                    <div className="rounded-xl bg-white p-3 border border-red-100">
                      <p className="text-sm font-black text-red-700">안전을 최우선으로 합니다.</p>
                      <p className="text-xs text-red-600 leading-relaxed mt-1">
                        정확도가 50% 미만이라 분석 결과를 표시하지 않습니다. 잘못된 약 정보 제공을 막기 위한 안전 조치입니다.
                      </p>
                    </div>
                    <CommunityButton label="전문가에게 문의하러 가기" />
                  </>
                ) : (
                  <>
                    <div className="rounded-xl bg-white p-3 border border-slate-100">
                      <p className="text-[10px] font-black text-blue-500 uppercase mb-1">AI Analysis Report</p>
                      <p className="text-xs text-slate-600 leading-relaxed">식약처 데이터와 대조된 약품 정보입니다.</p>
                    </div>
                    {needsCommunity && (
                      <div className="rounded-xl bg-amber-100 p-3 border border-amber-200">
                        <p className="text-xs text-amber-800 leading-relaxed">
                          정확도가 70% 이하입니다. 최종 복용 전 실제 약품 외형을 다시 확인하거나 전문가에게 질문하세요.
                        </p>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <span className="text-xs font-bold text-slate-400 w-14 shrink-0">성분</span>
                      <span className="text-xs text-slate-600">{pill.activeIngredients?.join(', ') || '식약처 데이터 없음'}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-xs font-bold text-slate-400 w-14 shrink-0">효능</span>
                      <span className="text-xs text-slate-600">{pill.description || '효능 데이터 없음'}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-xs font-bold text-slate-400 w-14 shrink-0">복용법</span>
                      <span className="text-xs text-slate-600">{pill.dosageGuide || '식약처 데이터 없음'}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-xs font-bold text-slate-400 w-14 shrink-0">주의사항</span>
                      <span className="text-xs text-slate-600">{pill.warnings || '식약처 데이터 없음'}</span>
                    </div>
                    {pill.storageMethod && (
                      <div className="flex gap-2">
                        <span className="text-xs font-bold text-slate-400 w-14 shrink-0">보관법</span>
                        <span className="text-xs text-slate-600">{pill.storageMethod}</span>
                      </div>
                    )}
                    {pill.entpName && (
                      <div className="flex gap-2">
                        <span className="text-xs font-bold text-slate-400 w-14 shrink-0">제조사</span>
                        <span className="text-xs text-slate-600">{pill.entpName}</span>
                      </div>
                    )}
                    {needsCommunity && <CommunityButton />}
                    {import.meta.env.DEV && onCorrectPill && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onCorrectPill(i, pill) }}
                        className="mt-2 w-full py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-xs font-bold active:scale-95 transition-all"
                      >
                        ✏️ 이 약 정정하기
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function AnalysisEvidenceCard({ pill, symptom, pillCount = 1 }) {
  if (!pill) return null
  const confidencePct = getConfidencePct(pill.confidence)
  const confidenceBand = getConfidenceBand(pill.confidence)

  if (confidenceBand === 'blocked') {
    return (
      <div className="rounded-2xl p-4 border-2 border-red-300 bg-red-50 animate-slide-up space-y-3 shadow-sm shadow-red-100">
        <div className="flex items-center gap-2">
          <span className="text-xl">🚫</span>
          <p className="font-black text-red-800 text-lg">안전을 최우선으로 합니다.</p>
          <span className="ml-auto text-xs font-black text-red-700 bg-red-100 px-2 py-1 rounded-full">{confidencePct}%</span>
        </div>
        <p className="text-sm text-red-700 leading-relaxed font-medium">
          AI 분석 정확도가 50% 미만이라 약 정보를 표시하지 않습니다. 사용자가 확신이 들지 않을 때는 전문가에게 문의하도록 연결합니다.
        </p>
        <CommunityButton label="전문가에게 문의하러 가기" />
      </div>
    )
  }

  const isLow = confidenceBand === 'low'
  const hasMultiplePills = pillCount > 1
  const symptomText = symptom?.trim() || '입력하신 증상'
  const pillClassName = pill.className || ''
  const approvedPurpose = pillClassName || pill.description || ''
  const dosageText = pill.dosageGuide && pill.dosageGuide !== '-' ? pill.dosageGuide : '복용 전 약사에게 문의하세요.'
  const warningText = pill.warnings || '복용 전 약사에게 확인하세요.'
  const efcyText = pill.description || ''

  return (
    <div className={`rounded-2xl p-4 border-2 animate-slide-up space-y-3 ${isLow ? 'border-amber-200 bg-amber-50' : 'border-blue-200 bg-blue-50'}`}>
      <div className="flex items-start gap-3">
        <div className={`w-12 h-12 rounded-2xl flex flex-col items-center justify-center shrink-0 ${isLow ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
          <span className="text-base font-black leading-none">{confidencePct}%</span>
          <span className="text-[9px] font-bold">일치</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className={`font-black text-sm ${isLow ? 'text-amber-800' : 'text-blue-800'}`}>
            식약처 데이터 대조 결과: {isLow ? '추가 확인이 필요합니다' : '식약처 데이터와 일치합니다'}
          </p>
          <p className="text-xs text-slate-600 leading-relaxed mt-1">아래 정보는 식약처 데이터와 대조된 약품 정보입니다.</p>
        </div>
      </div>
      <div className="rounded-xl bg-white p-3 border border-slate-100">
        <p className="text-[10px] font-black text-slate-400 uppercase mb-2">분석된 알약 정보</p>
        <div className="space-y-2 text-sm text-slate-700 leading-relaxed font-medium">
          <p className="font-bold">• {pill.summary}{pill.isPrescription ? ' (전문의약품)' : ''}</p>
          {approvedPurpose ? (
            <div className="rounded-xl bg-green-50 p-3 border border-green-200">
              <p className="text-green-800">
                {hasMultiplePills
                  ? `이 약들은 ${approvedPurpose.replace(/[\[\]]/g, '')} 목적으로 허가된 의약품입니다.`
                  : `이 약은 ${approvedPurpose.replace(/[\[\]]/g, '')} 목적으로 허가된 의약품입니다.`}
                {symptom?.trim() && (approvedPurpose.includes(symptom.trim()) || ['두통','발열','통증','소화','기침','위','장'].some(k => symptom.includes(k) && approvedPurpose.includes(k))
                  ? ` 사용자님의 [${symptomText}] 증상에 도움이 될 수 있습니다.`
                  : ` 사용자님의 [${symptomText}] 증상 목적으로 허가된 제품이 아닐 수 있습니다.`)}
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-slate-50 p-3 border border-slate-100">
              <p>식약처 허가 분류 정보를 확인할 수 없습니다.</p>
            </div>
          )}
          {efcyText && <p>• 효능: {efcyText}</p>}
          <p>• 복용법: {dosageText}</p>
          <p>• 주의사항: {warningText}</p>
          {isLow && <p>• 더 정확한 확인이 필요하신가요? 약사 커뮤니티를 이용해 주세요.</p>}
        </div>
      </div>
      {isLow && <CommunityButton />}
    </div>
  )
}

function ResultCard({ result, mfdsInfo, onChat, onRetry }) {
  const statusCode = result?.statusCode || 'unidentified'
  const s = STATUS_MAP[statusCode] || STATUS_MAP.unidentified
  const StatusIcon = s.icon
  const [showMfds, setShowMfds] = useState(false)

  if (!result || result.statusCode === 'unidentified') {
    return (
      <div className={`rounded-3xl border-2 ${s.border} ${s.bg} p-6 space-y-4 animate-slide-up`}>
        <div className="flex items-center gap-3">
          <StatusIcon className={`${s.text} shrink-0`} size={28} />
          <div>
            <p className={`font-bold text-lg ${s.text}`}>{result?.summary || '약품 미인식'}</p>
            <p className="text-sm text-slate-500">{result?.description || '이미지를 다시 촬영해주세요.'}</p>
          </div>
        </div>
        <button onClick={onRetry} className="w-full py-3 rounded-2xl bg-slate-800 text-white font-semibold flex items-center justify-center gap-2 active:scale-95 transition-transform">
          <RefreshCw size={16} /> 다시 촬영하기
        </button>
      </div>
    )
  }

  const RECOMMEND_MAP = {
    safe:    { text: '추천합니다!',        bg: 'bg-green-500', emoji: '✅' },
    caution: { text: '주의가 필요해요!',   bg: 'bg-amber-500', emoji: '⚠️' },
    danger:  { text: '추천하지 않습니다!', bg: 'bg-red-500',   emoji: '❌' },
  }
  const rec = RECOMMEND_MAP[statusCode] || RECOMMEND_MAP.caution

  return (
    <div className={`rounded-3xl border-2 ${s.border} ${s.bg} overflow-hidden animate-slide-up`}>
      <div className={`${rec.bg} px-5 py-4 flex items-center justify-center gap-2`}>
        <span className="text-2xl">{rec.emoji}</span>
        <p className="text-white font-black text-2xl tracking-tight">{rec.text}</p>
      </div>

      {result.oneLineSummary && (
        <div className="px-5 py-3 bg-white border-b border-slate-100">
          <p className="text-slate-700 font-semibold text-sm text-center">{result.oneLineSummary}</p>
        </div>
      )}

      {mfdsInfo && (
        <div className="px-5 py-2 bg-blue-50 border-b border-blue-100 flex items-center gap-2">
          <Database size={13} className="text-[#0192F5]" />
          <p className="text-xs text-[#0192F5] font-semibold">식품의약품안전처 공식 정보 확인됨</p>
          <span className="ml-auto text-xs text-blue-300">{mfdsInfo.entpName}</span>
        </div>
      )}

      {result.permitFound && (
        <div className="px-5 py-2 bg-purple-50 border-b border-purple-100 flex items-center gap-2">
          <Shield size={13} className="text-purple-500" />
          <p className="text-xs text-purple-600 font-semibold">의약품 제품허가 정보 연동됨</p>
          {result.etcOtcName && (
            <span className="ml-auto text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full font-semibold">{result.drugType}</span>
          )}
        </div>
      )}

      <div className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <StatusIcon className={`${s.text} shrink-0`} size={24} />
            <div className="min-w-0">
              <p className={`font-black text-lg leading-tight ${s.text} truncate`}>{result.summary}</p>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.badge}`}>{result.statusText || s.label}</span>
            </div>
          </div>
          <span className="text-xs bg-slate-100 text-slate-500 px-2 py-1 rounded-full shrink-0">{result.drugType}</span>
        </div>
        <p className="text-sm text-slate-600 leading-relaxed">{result.description}</p>
      </div>

      <div className="mx-4 mb-4 bg-white rounded-2xl divide-y divide-slate-100 shadow-sm">
        <InfoRow icon={Clock} label="복용 방법" value={mfdsInfo?.useMethodQesitm || result.dosageGuide} source={mfdsInfo?.useMethodQesitm ? '식약처' : 'AI'} />
        <InfoRow icon={Shield} label="주의사항" value={mfdsInfo?.atpnQesitm || result.warnings} source={mfdsInfo?.atpnQesitm ? '식약처' : 'AI'} />
        {(mfdsInfo?.seQesitm) && <InfoRow icon={AlertTriangle} label="부작용" value={mfdsInfo.seQesitm} source="식약처" />}
      </div>

      {result.activeIngredients?.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {result.activeIngredients.map((ing, i) => (
            <span key={i} className="text-xs bg-white text-slate-600 px-2.5 py-1 rounded-full border border-slate-200 font-medium">{ing}</span>
          ))}
        </div>
      )}

      {mfdsInfo && (
        <div className="mx-4 mb-4">
          <button onClick={() => setShowMfds(!showMfds)} className="w-full py-2.5 rounded-2xl border border-blue-100 bg-blue-50 text-xs text-[#0192F5] font-semibold flex items-center justify-center gap-2">
            <Database size={13} />
            {showMfds ? '식약처 공식 정보 접기' : '식약처 공식 정보 더 보기'}
          </button>
          {showMfds && (
            <div className="mt-2 bg-white rounded-2xl border border-blue-100 divide-y divide-slate-50 overflow-hidden">
              {mfdsInfo.efcyQesitm && <MfdsRow label="효능" value={mfdsInfo.efcyQesitm} />}
              {mfdsInfo.atpnWarnQesitm && <MfdsRow label="경고" value={mfdsInfo.atpnWarnQesitm} highlight />}
              {mfdsInfo.intrcQesitm && <MfdsRow label="상호작용" value={mfdsInfo.intrcQesitm} />}
              {mfdsInfo.depositMethodQesitm && <MfdsRow label="보관법" value={mfdsInfo.depositMethodQesitm} />}
              {result.permitFound && (
                <>
                  {result.permitDate    && <MfdsRow label="허가일자"  value={result.permitDate} />}
                  {result.storageMethod && <MfdsRow label="저장방법"  value={result.storageMethod} />}
                  {result.validTerm     && <MfdsRow label="유효기간"  value={result.validTerm} />}
                  {result.packUnit      && <MfdsRow label="포장단위"  value={result.packUnit} />}
                  {result.cancelName    && result.cancelName !== '정상' && (
                    <MfdsRow label="허가상태" value={result.cancelName} highlight />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {result.interactions?.length > 0 && (
        <div className="mx-4 mb-4 p-3 bg-amber-50 rounded-2xl border border-amber-100">
          <p className="text-xs font-bold text-amber-700 mb-1 flex items-center gap-1">
            <AlertTriangle size={12} /> 병용 주의
          </p>
          <p className="text-xs text-amber-600">{result.interactions.join(', ')}</p>
        </div>
      )}

      {/* 신뢰도 — 3케이스 분기 */}
      {result.confidence !== undefined && (() => {
        const pct = Math.round((result.confidence || 0) * 100)

        if (pct >= 80) return (
          <div className="mx-4 mb-4 rounded-2xl p-4 space-y-3" style={{ background: '#eff6ff', border: '2px solid #bfdbfe' }}>
            <div className="flex items-center gap-3">
              <div className="text-center shrink-0">
                <p className="font-black text-4xl leading-none text-[#0192F5]">{pct}%</p>
                <p className="text-xs font-medium mt-1 text-[#0192F5]">데이터 일치율</p>
              </div>
              <div className="flex-1">
                <div className="h-3 bg-white rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-[#0192F5]" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs mt-2 font-bold text-[#0192F5]">✅ 식약처 데이터베이스와 일치합니다</p>
              </div>
            </div>
            {result.description && (
              <div className="bg-white rounded-xl p-3 border border-blue-100">
                <p className="text-[10px] font-bold text-blue-400 uppercase tracking-wide mb-1">식약처 데이터 분석 결과</p>
                <p className="text-sm text-slate-700 leading-relaxed font-medium">{result.description}</p>
              </div>
            )}
          </div>
        )

        if (pct >= 50) return (
          <div className="mx-4 mb-4 rounded-2xl overflow-hidden" style={{ border: '2px solid #fde68a' }}>
            <div className="px-4 py-3 flex items-center gap-2" style={{ background: '#fffbeb' }}>
              <span className="text-base">⚠️</span>
              <p className="text-xs font-black text-amber-700 flex-1">데이터 정밀 분석 중</p>
              <span className="text-xs font-black text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">일치율 {pct}%</span>
            </div>
            <div className="px-4 py-3 bg-white space-y-2">
              <p className="text-sm text-slate-700 leading-relaxed">
                식약처 데이터베이스와 <span className="font-black text-amber-600">{pct}% 일치</span>하는 의약품 정보는{' '}
                <span className="font-black text-slate-800">{result.summary}</span>입니다.
                {result.description ? ` 해당 의약품은 주로 ${result.description}` : ''}
              </p>
              <div className="rounded-xl p-3" style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
                <p className="text-xs text-amber-700 leading-relaxed">
                  <span className="font-black">[주의]</span> 분석 일치율이 80% 미만인 경우, 사진 상태에 따라 정보 왜곡이 발생할 수 있습니다.
                  본 앱은 데이터 대조 결과만을 제공하며, <span className="font-bold">최종 복용 결정에 따른 책임은 전적으로 사용자에게 있습니다.</span>
                </p>
              </div>
              <a
                href={COMMUNITY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-3 rounded-xl font-bold text-sm text-white"
                style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}
              >
                💬 아하 게시판에서 약사에게 질문하기 →
              </a>
            </div>
          </div>
        )

        return (
          <div className="mx-4 mb-4 rounded-2xl overflow-hidden" style={{ border: '2px solid #fecaca' }}>
            <div className="px-4 py-3 flex items-center gap-2 bg-red-500">
              <span className="text-base">🚫</span>
              <p className="text-sm font-black text-white flex-1">복용 위험 감지 — AI 분석 중단</p>
              <span className="text-xs font-bold text-red-200 bg-red-600 px-2 py-0.5 rounded-full">{pct}%</span>
            </div>
            <div className="px-4 py-4 bg-red-50 space-y-3">
              <p className="text-sm text-red-800 leading-relaxed font-medium">
                현재 데이터 일치율이 현저히 낮아({pct}% 미만), 잘못된 정보 제공으로 인한
                <span className="font-black"> 약물 오남용 위험이 감지</span>되었습니다.
              </p>
              <div className="bg-white rounded-xl p-3 border border-red-100">
                <p className="text-xs text-red-600 leading-relaxed">
                  사용자의 안전을 최우선으로 하여 AI 분석 결과를 표시하지 않습니다.
                  아래 게시판을 통해 전문 약사에게 질문하여 안전한 복용 안내를 받으십시오.
                </p>
              </div>
              <a
                href={COMMUNITY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl font-black text-sm text-white"
                style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)' }}
              >
                💬 아하 게시판에서 약사에게 질문하기 →
              </a>
            </div>
          </div>
        )
      })()}

      <div className="p-4 pt-0">
        <button onClick={onChat} className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-[#0192F5] to-[#40BEFD] text-white font-bold flex items-center justify-center gap-2 shadow-md active:scale-95 transition-all">
          <MessageCircle size={18} /> AI 약사에게 더 물어보기
        </button>
      </div>
    </div>
  )
}

function InfoRow({ icon: Icon, label, value, source }) {
  if (!value) return null
  const displayValue = value.length > 100 ? value.slice(0, 100) + '...' : value
  return (
    <div className="flex gap-3 p-3">
      <div className="w-7 h-7 rounded-xl bg-blue-50 flex items-center justify-center shrink-0 mt-0.5">
        <Icon size={14} className="text-[#0192F5]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wide">{label}</p>
          {source && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${source === '식약처' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>
              {source}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-700 leading-snug">{displayValue}</p>
      </div>
    </div>
  )
}

function MfdsRow({ label, value, highlight }) {
  if (!value) return null
  const displayValue = value.length > 150 ? value.slice(0, 150) + '...' : value
  return (
    <div className={`p-3 ${highlight ? 'bg-red-50' : ''}`}>
      <p className={`text-xs font-bold mb-1 ${highlight ? 'text-red-600' : 'text-slate-400'}`}>{label}</p>
      <p className="text-xs text-slate-600 leading-relaxed">{displayValue}</p>
    </div>
  )
}

function AnalyzingSkeleton({ mfdsLoading }) {
  return (
    <div className="rounded-3xl border-2 border-blue-100 bg-blue-50 p-6 space-y-4 animate-pulse">
      <div className="flex items-center gap-3">
        <Loader2 size={28} className="text-[#40BEFD] animate-spin" />
        <div className="flex-1 space-y-2">
          <div className="h-5 bg-blue-200 rounded-lg w-3/4" />
          <div className="h-3 bg-blue-200 rounded w-1/2" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-3 bg-blue-200 rounded w-full" />
        <div className="h-3 bg-blue-200 rounded w-5/6" />
      </div>
      <p className="text-center text-sm text-[#0192F5] font-medium">
        {mfdsLoading ? '🏥 식약처 DB 검색 중...' : '🔍 AI가 약품을 분석하고 있어요...'}
      </p>
    </div>
  )
}

// ─── 채팅 뷰 ─────────────────────────────────────────────────────────────────
function ChatView({ result, mfdsInfo, userConditions, onBack }) {
  const [messages, setMessages] = useState([{
    role: 'assistant',
    content: `안녕하세요! 👋 **${result?.summary || '분석된 약품'}**에 대해 무엇이든 물어보세요.\n\n복용 방법, 부작용, 다른 약과의 상호작용 등을 도와드릴 수 있어요.${mfdsInfo ? '\n\n✅ 식약처 공식 정보를 바탕으로 답변해드릴게요.' : ''}`,
    ts: Date.now(),
  }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || loading) return
    const userMsg = { role: 'user', content: text, ts: Date.now() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)
    try {
      const history = messages.slice(1).map(m => ({ role: m.role, content: m.content }))
      const data = await safeFetchGroq({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: buildChatSystemPrompt(result, mfdsInfo, userConditions) },
          ...history,
          { role: 'user', content: text }
        ],
        temperature: 0.3,
        max_tokens: 600,
      })
      const reply = data.choices?.[0]?.message?.content || '죄송합니다, 응답을 가져오지 못했어요.'
      setMessages(prev => [...prev, { role: 'assistant', content: reply, ts: Date.now() }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ 오류: ${e.message}`, ts: Date.now() }])
    } finally { setLoading(false) }
  }

  return (
    <div className="flex flex-col h-[100dvh]">
      <div className="sticky top-0 z-10 px-4 pt-4 pb-3 border-b border-slate-100 bg-white flex items-center gap-3">
        <button onClick={onBack} className="w-9 h-9 rounded-2xl bg-slate-100 flex items-center justify-center">
          <ChevronLeft size={20} className="text-slate-600" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-slate-800 text-sm truncate">AI 약사 상담</p>
          <p className="text-xs text-slate-400 truncate">{result?.summary}{mfdsInfo ? ' · 식약처 인증' : ''}</p>
        </div>
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#0192F5] to-[#40BEFD] flex items-center justify-center">
          <Sparkles size={15} className="text-white" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-[#0192F5] to-[#40BEFD] flex items-center justify-center mr-2 mt-1 shrink-0">
                <Sparkles size={13} className="text-white" />
              </div>
            )}
            <div className={`max-w-[78%] px-4 py-3 rounded-3xl text-sm leading-relaxed whitespace-pre-wrap ${
              msg.role === 'user' ? 'bg-gradient-to-br from-[#0192F5] to-[#40BEFD] text-white rounded-br-lg' : 'bg-slate-100 text-slate-800 rounded-bl-lg'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex items-start gap-2">
            <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-[#0192F5] to-[#40BEFD] flex items-center justify-center shrink-0">
              <Sparkles size={13} className="text-white" />
            </div>
            <div className="bg-slate-100 px-4 py-3 rounded-3xl rounded-bl-lg flex items-center gap-1.5">
              {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: `${i*0.15}s` }} />)}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {messages.length <= 2 && (
        <div className="px-4 pb-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {['식전에 먹어도 돼요?', '어떤 효과가 있나요?', '다른 약과 같이 먹어도 되나요?', '부작용이 뭔가요?'].map(q => (
              <button key={q} onClick={() => { setInput(q); inputRef.current?.focus() }}
                className="shrink-0 text-xs bg-blue-50 text-[#0192F5] px-3 py-2 rounded-2xl border border-blue-100 font-medium whitespace-nowrap">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 pb-10 pt-2 border-t border-slate-100 bg-white">
        <div className="flex items-end gap-2 bg-slate-100 rounded-3xl px-4 py-2">
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            placeholder="약에 대해 질문하세요..." rows={1}
            className="flex-1 bg-transparent text-sm text-slate-800 placeholder-slate-400 resize-none outline-none max-h-24 py-1.5" />
          <button onClick={sendMessage} disabled={!input.trim() || loading}
            className="w-9 h-9 rounded-2xl bg-gradient-to-br from-[#0192F5] to-[#40BEFD] flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-95 transition-all mb-0.5">
            <Send size={15} className="text-white" />
          </button>
        </div>
        <DisclaimerBar />
      </div>
    </div>
  )
}

// ─── 히스토리 뷰 (Base64 썸네일 + 게스트 안내) ──────────────────────────────
function HistoryView({ logs, onSelect, onBack, isGuest, onLoginRequest }) {
  // 게스트인 경우 로그인 유도
  if (isGuest) {
    return (
      <div className="flex flex-col h-[100dvh]">
        <div className="sticky top-0 z-10 px-4 pt-4 pb-3 border-b border-slate-100 bg-white flex items-center gap-3">
          <button onClick={onBack} className="w-9 h-9 rounded-2xl bg-slate-100 flex items-center justify-center">
            <ChevronLeft size={20} className="text-slate-600" />
          </button>
          <p className="flex-1 font-bold text-slate-800">분석 기록</p>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 space-y-4 px-8">
          <div className="w-20 h-20 rounded-3xl bg-blue-50 flex items-center justify-center text-4xl">🔒</div>
          <div className="text-center space-y-1">
            <p className="font-bold text-slate-700 text-base">로그인이 필요해요</p>
            <p className="text-xs leading-relaxed text-slate-400">분석 기록은 로그인한 유저만 저장돼요.<br/>회원가입하면 내 복약 히스토리를 볼 수 있어요.</p>
          </div>
          <button onClick={onLoginRequest}
            className="px-6 py-3 bg-[#0192F5] text-white rounded-2xl font-bold text-sm active:scale-95 transition-transform">
            로그인하러 가기
          </button>
        </div>
      </div>
    )
  }

  if (logs.length === 0) {
    return (
      <div className="flex flex-col h-[100dvh]">
        <div className="sticky top-0 z-10 px-4 pt-4 pb-3 border-b border-slate-100 bg-white flex items-center gap-3">
          <button onClick={onBack} className="w-9 h-9 rounded-2xl bg-slate-100 flex items-center justify-center">
            <ChevronLeft size={20} className="text-slate-600" />
          </button>
          <p className="flex-1 font-bold text-slate-800">분석 기록</p>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 space-y-3 px-8">
          <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center">
            <History size={32} className="text-slate-300" />
          </div>
          <p className="text-sm font-medium">아직 분석 기록이 없어요</p>
          <p className="text-xs text-center leading-relaxed">약품 사진을 촬영하면<br/>분석 결과가 여기에 저장됩니다.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[100dvh]">
      <div className="sticky top-0 z-10 px-4 pt-4 pb-3 border-b border-slate-100 bg-white flex items-center gap-3">
        <button onClick={onBack} className="w-9 h-9 rounded-2xl bg-slate-100 flex items-center justify-center">
          <ChevronLeft size={20} className="text-slate-600" />
        </button>
        <p className="flex-1 font-bold text-slate-800">나의 복약 히스토리</p>
        <span className="text-xs bg-blue-50 text-blue-500 font-bold px-2 py-1 rounded-full">{logs.length}건</span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {logs.map((log, i) => {
          const s = STATUS_MAP[log.statusCode] || STATUS_MAP.unidentified
          const StatusIcon = s.icon
          const confidencePct = getConfidencePct(log.confidence)
          return (
            <button key={log.id || i} onClick={() => onSelect(log)}
              className="w-full bg-white p-3 rounded-3xl border border-slate-100 shadow-sm flex gap-3 items-center active:scale-[0.99] transition-all text-left">
              {/* 히스토리 썸네일 (Base64) */}
              <div className="w-14 h-14 bg-slate-100 rounded-2xl overflow-hidden relative shrink-0 border border-slate-200/60">
                {log.imageBase64
                  ? <img src={log.imageBase64} className="w-full h-full object-cover" alt="약품" loading="lazy" />
                  : <div className="w-full h-full flex items-center justify-center text-2xl">💊</div>
                }
                {confidencePct > 0 && (
                  <div className="absolute bottom-0 inset-x-0 bg-black/50 text-[9px] text-white font-black text-center py-0.5 backdrop-blur-sm">
                    {confidencePct}%
                  </div>
                )}
              </div>
              {/* 메타 */}
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${s.badge}`}>
                    {log.statusText || s.label}
                  </span>
                  <span className="text-[10px] text-slate-400">
                    {log.createdAt?.toDate?.()?.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) || ''}
                  </span>
                </div>
                <p className="font-black text-slate-800 text-sm truncate">{log.summary || '미분석 약품'}</p>
                {log.userConditions && (
                  <p className="text-xs text-slate-400 truncate">{log.userConditions}</p>
                )}
              </div>
              <ChevronRight size={16} className="text-slate-300 shrink-0" />
            </button>
          )
        })}
      </div>
    </div>
  )
}


// ─── 관리자 뷰 (통계 / 기록 / 유저 / 정정 — 4탭) ────────────────────────────
function AdminView({ logs, corrections, allUsers, onBack, onUpdateUserRole }) {
  const [adminTab, setAdminTab] = useState('stats')
  const [accuracyFilter, setAccuracyFilter] = useState(null) // null | 'high' | 'low'

  // ── 통계 계산 ──────────────────────────────────────────────────────────────
  const total        = logs.length
  const today        = new Date()
  const todayCount   = logs.filter(l => {
    const d = l.createdAt?.toDate?.()
    return d && d.toDateString() === today.toDateString()
  }).length

  // AI 정확도 80% 기준
  const highAccCount = logs.filter(l => getConfidencePct(l.confidence) >= 80).length
  const lowAccCount  = total - highAccCount
  const highAccPct   = total > 0 ? Math.round((highAccCount / total) * 100) : 0
  const lowAccPct    = total > 0 ? Math.round((lowAccCount  / total) * 100) : 0

  // 유저별 분석 횟수
  const logCountByUser = logs.reduce((acc, l) => {
    if (l.userId) acc[l.userId] = (acc[l.userId] || 0) + 1
    return acc
  }, {})

  const TABS = [
    { key: 'stats',       label: '통계',                       icon: '📊' },
    { key: 'logs',        label: `기록(${logs.length})`,        icon: '📋' },
    { key: 'users',       label: `유저(${allUsers.length})`,    icon: '👥' },
    { key: 'corrections', label: `정정(${corrections.length})`, icon: '🔧' },
  ]

  // 정확도 클릭 → 기록 탭 이동 + 필터 적용
  const handleAccuracyClick = (type) => {
    setAccuracyFilter(type)
    setAdminTab('logs')
  }

  // 기록 탭 표시 로그 (필터 적용)
  const filteredLogs = accuracyFilter === 'high'
    ? logs.filter(l => getConfidencePct(l.confidence) >= 80)
    : accuracyFilter === 'low'
    ? logs.filter(l => getConfidencePct(l.confidence) < 80)
    : logs

  return (
    <div className="flex flex-col h-[100dvh] bg-[#0f172a]">
      {/* ── 헤더 ── */}
      <div className="px-5 pt-6 pb-0 bg-gradient-to-b from-[#1e293b] to-[#0f172a] border-b border-white/5 sticky top-0 z-10">
        <div className="flex items-center gap-3 pb-3">
          <button onClick={onBack} className="w-9 h-9 rounded-2xl bg-white/10 flex items-center justify-center">
            <ChevronLeft size={20} className="text-white" />
          </button>
          <div className="w-9 h-9 rounded-2xl bg-gradient-to-br from-[#0192F5] to-[#40BEFD] flex items-center justify-center">
            <Shield size={16} className="text-white" />
          </div>
          <div className="flex-1">
            <p className="font-bold text-white text-sm">Master 대시보드</p>
            <p className="text-xs text-slate-400">이거돼? 서비스 현황</p>
          </div>
          <span className="bg-blue-500/20 text-blue-300 text-xs px-2.5 py-1 rounded-full font-bold border border-blue-500/30">Admin</span>
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        </div>
        {/* 4탭 */}
        <div className="grid grid-cols-4 gap-0.5">
          {TABS.map(t => (
            <button key={t.key}
              onClick={() => { setAdminTab(t.key); if (t.key !== 'logs') setAccuracyFilter(null) }}
              className={`py-2 text-[11px] font-bold rounded-t-xl transition-all leading-tight ${adminTab === t.key ? 'bg-[#0f172a] text-white' : 'text-slate-500 hover:text-slate-300'}`}>
              <span className="block">{t.icon}</span>
              <span className="block">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">

        {/* ══ 통계 탭 ══ */}
        {adminTab === 'stats' && (
          <>
            {/* 요약 카드 2열 — 총/오늘/유저/정정 */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: '총 분석',   value: `${total}회`,             color: '#60a5fa', bg: 'rgba(96,165,250,0.1)',   icon: '📊' },
                { label: '오늘 분석', value: `${todayCount}건`,         color: '#34d399', bg: 'rgba(52,211,153,0.1)',  icon: '✨' },
                { label: '가입 유저', value: `${allUsers.length}명`,    color: '#a78bfa', bg: 'rgba(167,139,250,0.1)', icon: '👥' },
                { label: '정정 요청', value: `${corrections.length}건`, color: '#fb923c', bg: 'rgba(251,146,60,0.1)',  icon: '✏️' },
              ].map(({ label, value, color, bg, icon }) => (
                <div key={label} className="rounded-2xl border border-white/5 p-4 flex flex-col gap-2" style={{ background: bg }}>
                  <div className="flex items-center justify-between">
                    <p className="text-slate-400 text-xs font-medium">{label}</p>
                    <span className="text-base">{icon}</span>
                  </div>
                  <p className="text-2xl font-black" style={{ color }}>{value}</p>
                </div>
              ))}
            </div>

            {/* AI 정확도 분포 */}
            <div className="bg-white/5 rounded-2xl p-5 border border-white/5 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-slate-400 text-xs font-semibold uppercase tracking-wider">AI 정확도 분포</p>
                <p className="text-slate-600 text-[11px]">클릭하면 해당 기록으로 이동</p>
              </div>

              {/* 80% 이상 */}
              <button onClick={() => handleAccuracyClick('high')}
                className="w-full space-y-1.5 text-left active:scale-[0.98] transition-transform">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                    <p className="text-slate-300 text-sm">80% 이상 (신뢰)</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-sm text-emerald-400">{highAccCount}건</p>
                    <span className="text-xs text-emerald-300 bg-emerald-500/20 px-2 py-0.5 rounded-full font-bold border border-emerald-500/30">
                      {highAccPct}%
                    </span>
                    <ChevronRight size={14} className="text-slate-500" />
                  </div>
                </div>
                <div className="h-2 rounded-full overflow-hidden bg-emerald-500/10">
                  <div className="h-full rounded-full bg-emerald-400 transition-all duration-700"
                    style={{ width: `${highAccPct}%` }} />
                </div>
              </button>

              {/* 80% 미만 */}
              <button onClick={() => handleAccuracyClick('low')}
                className="w-full space-y-1.5 text-left active:scale-[0.98] transition-transform">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                    <p className="text-slate-300 text-sm">80% 미만 (주의)</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-sm text-amber-400">{lowAccCount}건</p>
                    <span className="text-xs text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded-full font-bold border border-amber-500/30">
                      {lowAccPct}%
                    </span>
                    <ChevronRight size={14} className="text-slate-500" />
                  </div>
                </div>
                <div className="h-2 rounded-full overflow-hidden bg-amber-500/10">
                  <div className="h-full rounded-full bg-amber-400 transition-all duration-700"
                    style={{ width: `${lowAccPct}%` }} />
                </div>
              </button>
            </div>
          </>
        )}

        {/* ══ 기록 탭 — 전체 계정 통합 최신 기록 ══ */}
        {adminTab === 'logs' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-1">
              <p className="text-xs font-black text-slate-400 uppercase tracking-wider flex-1">
                {accuracyFilter === 'high' ? '80% 이상 기록' : accuracyFilter === 'low' ? '80% 미만 기록' : '전체 분석 기록'} {filteredLogs.length}건
              </p>
              {accuracyFilter && (
                <button onClick={() => setAccuracyFilter(null)}
                  className={`flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full border ${
                    accuracyFilter === 'high'
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                      : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                  }`}>
                  {accuracyFilter === 'high' ? '▲ 80% 이상' : '▼ 80% 미만'}
                  <X size={10} />
                </button>
              )}
            </div>
            {filteredLogs.length === 0 && (
              <p className="text-center text-slate-500 text-sm py-10">분석 기록이 없습니다.</p>
            )}
            {filteredLogs.map((log, i) => {
              const pct     = getConfidencePct(log.confidence)
              const trusted = pct >= 80
              const dateStr = log.createdAt?.toDate?.()?.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) || '-'
              const owner   = allUsers.find(u => u.uid === log.userId)
              const email   = owner?.email || log.userId?.slice(0, 8) || '알 수 없음'
              return (
                <div key={log.id || i} className="bg-white/5 rounded-2xl border border-white/5 p-3 flex gap-3 items-center">
                  {/* 썸네일 */}
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-white/10 shrink-0 border border-white/10">
                    {log.imageBase64
                      ? <img
                          src={log.imageBase64.startsWith('data:') ? log.imageBase64 : `data:image/jpeg;base64,${log.imageBase64}`}
                          className="w-full h-full object-cover" alt="약품" loading="lazy"
                        />
                      : <div className="w-full h-full flex items-center justify-center text-xl">💊</div>
                    }
                  </div>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${trusted ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-amber-500/20 text-amber-300 border-amber-500/30'}`}>
                        {trusted ? '▲' : '▼'} {pct}%
                      </span>
                      <span className="text-[10px] text-slate-500">{dateStr}</span>
                    </div>
                    <p className="text-white text-sm font-bold truncate">{log.summary || '미분석 약품'}</p>
                    <p className="text-slate-500 text-[11px] truncate">{email}</p>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ══ 유저 관리 탭 ══ */}
        {adminTab === 'users' && (
          <div className="space-y-3">
            <p className="text-xs font-black text-slate-400 uppercase tracking-wider px-1">
              전체 가입 유저 {allUsers.length}명
            </p>
            {allUsers.length === 0 && (
              <p className="text-center text-slate-500 text-sm py-10">가입된 유저가 없습니다.</p>
            )}
            {allUsers.map((user) => {
              const isAdmin  = user.role === 'admin'
              const userLogs = logCountByUser[user.uid] || 0
              const joinDate = user.createdAt?.toDate?.()?.toLocaleDateString('ko-KR', { year: '2-digit', month: 'short', day: 'numeric' }) || '-'
              return (
                <div key={user.uid} className="bg-white/5 rounded-2xl border border-white/5 p-4 space-y-3 backdrop-blur-sm">
                  <div className="flex items-start gap-3">
                    <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-lg shrink-0 ${isAdmin ? 'bg-gradient-to-br from-blue-500 to-blue-600' : 'bg-white/10'}`}>
                      {isAdmin ? '👑' : '👤'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-white text-sm font-bold truncate">{user.email || '이메일 없음'}</p>
                        <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${isAdmin ? 'bg-blue-500/20 text-blue-300 border-blue-500/30' : 'bg-white/10 text-slate-400 border-white/10'}`}>
                          {isAdmin ? 'ADMIN' : 'USER'}
                        </span>
                      </div>
                      <div className="flex gap-3 mt-1">
                        <p className="text-xs text-slate-500">가입 {joinDate}</p>
                        <p className="text-xs text-slate-500">분석 <span className="text-slate-300 font-semibold">{userLogs}회</span></p>
                      </div>
                      <p className="text-[10px] text-slate-600 mt-0.5 font-mono truncate">{user.uid}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => onUpdateUserRole(user.uid, isAdmin ? 'user' : 'admin')}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all active:scale-95 ${isAdmin ? 'bg-red-500/15 text-red-300 border border-red-500/20 hover:bg-red-500/25' : 'bg-blue-500/15 text-blue-300 border border-blue-500/20 hover:bg-blue-500/25'}`}>
                      {isAdmin
                        ? <><UserX size={12} /> 관리자 해제</>
                        : <><UserCheck size={12} /> 관리자로 승격</>
                      }
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ══ 정정 요청 탭 ══ */}
        {adminTab === 'corrections' && (
          <div className="space-y-3">
            <p className="text-xs font-black text-slate-400 uppercase tracking-wider px-1">
              AI 데이터 정정 요청 {corrections.length}건
            </p>
            {corrections.length === 0 && (
              <p className="text-center text-slate-500 text-sm py-10">새로 들어온 정정 요청이 없습니다.</p>
            )}
            {corrections.map((corr, idx) => (
              <div key={idx} className="bg-white/5 p-4 rounded-2xl border border-white/5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">
                    {corr.createdAt?.toDate?.()?.toLocaleString('ko-KR') || '시간 없음'}
                  </span>
                  <span className="bg-red-500/20 text-red-300 text-[10px] font-black px-2 py-0.5 rounded-full border border-red-500/30">
                    정정 피드백
                  </span>
                </div>
                <div className="flex gap-3 items-center bg-white/5 p-2.5 rounded-xl">
                  <div className="w-12 h-12 bg-white/10 rounded-lg overflow-hidden shrink-0">
                    {corr.imageBase64
                      ? <img
                          src={corr.imageBase64.startsWith('data:') ? corr.imageBase64 : `data:image/jpeg;base64,${corr.imageBase64}`}
                          className="w-full h-full object-cover" alt="pill"
                        />
                      : <div className="w-full h-full flex items-center justify-center text-xl">💊</div>
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-500 line-through truncate">AI: {corr.originalResult}</p>
                    <p className="text-sm font-black text-white truncate">→ {corr.correctDrugName}</p>
                    <p className="text-[10px] text-slate-600 mt-0.5">
                      기존 정확도: {Math.round((corr.originalConfidence || 0) * 100)}%
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  )
}


// ─── 온보딩 슬라이드 ──────────────────────────────────────────────────────────
function OnboardingSlides({ onComplete }) {
  const [current, setCurrent] = useState(0)
  const slides = [
    {
      emoji: '💊',
      title: '앱 사용법',
      desc: '약 사진 한 장으로 식약처 공식 정보를 빠르게 대조하세요',
      tips: ['AI는 알약 종류 식별만 도와줘요', '복용 판단은 하지 않아요', '식약처 공식 데이터에 근거해 안내해요'],
      color: '#0192F5',
    },
    {
      emoji: '📸',
      title: '약을 찍어주세요',
      desc: '약 봉투 안 알약을 카메라로 찍거나 갤러리에서 사진을 올려주세요',
      tips: ['알약이 잘 보이게 가까이 찍어주세요', '각인 문자가 보이면 더 정확해요', '여러 알약이 있으면 한번에 찍어도 돼요'],
      color: '#0192F5',
    },
    {
      emoji: '🔍',
      title: '분석 결과 확인',
      desc: '정확도와 식약처 승인 효능을 함께 확인하세요',
      tips: ['정확도 퍼센트로 식별 신뢰도를 보여줘요', '성분, 복용법, 주의사항, 보관법을 확인할 수 있어요', '50% 미만이면 안전을 위해 약 정보를 숨겨요'],
      color: '#16A34A',
    },
    {
      emoji: '💬',
      title: '불확실하면 전문가에게',
      desc: '정확도가 낮거나 확신이 들지 않으면 약사 커뮤니티로 연결해요',
      tips: ['70% 이하 결과에는 질문 버튼을 보여줘요', '50% 미만 결과는 약 정보를 제공하지 않아요', '안전하지 않은 추측 답변을 줄이는 장치예요'],
      color: '#7C3AED',
    },
  ]

  const next = () => {
    if (current < slides.length - 1) setCurrent(current + 1)
    else onComplete()
  }

  const s = slides[current]

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 100, display: 'flex', flexDirection: 'column', maxWidth: 480, margin: '0 auto' }}>
      <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={onComplete} style={{ fontSize: 13, color: '#AAA', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          건너뛰기
        </button>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 32px', gap: 24 }}>
        <div style={{ width: 100, height: 100, borderRadius: '50%', background: `${s.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 52 }}>
          {s.emoji}
        </div>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.5px', marginBottom: 10 }}>{s.title}</h2>
          <p style={{ fontSize: 15, color: '#666', lineHeight: 1.7, whiteSpace: 'pre-line' }}>{s.desc}</p>
        </div>
        {current === 0 ? (
          <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {['AI 외형 식별', '식약처 공식 데이터 연동', '정확도 기반 안전 차단'].map((feat, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#F0F7FF', borderRadius: 14, padding: '14px 18px', border: '1px solid #BDE0FF' }}>
                <span style={{ fontSize: 18 }}>{['🤖', '🏥', '💊'][i]}</span>
                <span style={{ fontSize: 14, color: '#0192F5', fontWeight: 600 }}>{feat}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {s.tips.map((tip, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, background: `${s.color}08`, borderRadius: 14, padding: '12px 16px', border: `1px solid ${s.color}20` }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', background: s.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>{i + 1}</span>
                </div>
                <span style={{ fontSize: 13, color: '#444', lineHeight: 1.5 }}>{tip}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding: '20px 24px 40px', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {slides.map((_, i) => (
            <div key={i} onClick={() => setCurrent(i)} style={{ width: i === current ? 20 : 6, height: 6, borderRadius: 3, background: i === current ? s.color : '#DDD', cursor: 'pointer', transition: 'all 0.3s' }} />
          ))}
        </div>
        <button onClick={next} style={{ width: '100%', padding: '17px 0', borderRadius: 16, background: `linear-gradient(135deg, ${s.color}, ${s.color}CC)`, color: '#fff', border: 'none', fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '-0.2px' }}>
          {current < slides.length - 1 ? '다음' : '시작하기 →'}
        </button>
      </div>
    </div>
  )
}

// ─── 카메라 뷰 ────────────────────────────────────────────────────────────────
function CameraView({ onCapture, onCancel }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true
    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (!mounted) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); setReady(true) }
      } catch (e) { setError('카메라 접근 권한이 필요합니다.') }
    }
    start()
    return () => { mounted = false; streamRef.current?.getTracks().forEach(t => t.stop()) }
  }, [])

  const shoot = () => {
    if (!videoRef.current || !ready) return
    const canvas = document.createElement('canvas')
    canvas.width = videoRef.current.videoWidth
    canvas.height = videoRef.current.videoHeight
    canvas.getContext('2d').drawImage(videoRef.current, 0, 0)
    canvas.toBlob(blob => { streamRef.current?.getTracks().forEach(t => t.stop()); onCapture(blob) }, 'image/jpeg', 0.92)
  }

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
        {ready && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-72 h-48 rounded-3xl border-2 border-white/60 relative">
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1 rounded-full whitespace-nowrap">약품이 이 안에 들어오게 맞춰주세요</div>
            </div>
          </div>
        )}
        {!ready && !error && <div className="absolute inset-0 flex items-center justify-center"><Loader2 size={40} className="text-white animate-spin" /></div>}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center space-y-4">
            <XCircle size={48} className="text-red-400" />
            <p className="text-white text-sm">{error}</p>
            <button onClick={onCancel} className="px-6 py-2 bg-white text-slate-800 rounded-full font-semibold">돌아가기</button>
          </div>
        )}
        <button onClick={onCancel} className="absolute top-4 left-4 w-10 h-10 rounded-full bg-black/50 flex items-center justify-center">
          <X size={20} className="text-white" />
        </button>
      </div>
      {ready && (
        <div className="bg-black pb-12 pt-6 flex items-center justify-center">
          <button onClick={shoot} className="w-20 h-20 rounded-full border-4 border-white bg-white/20 flex items-center justify-center active:scale-90 transition-transform">
            <div className="w-14 h-14 rounded-full bg-white" />
          </button>
        </div>
      )}
    </div>
  )
}

// ─── 홈 뷰 ───────────────────────────────────────────────────────────────────
function HomeView({ userConditions, analysisResult, mfdsInfo, pillResults, combinedAnalysis, durWarnings, analyzing, mfdsLoading, onCameraCapture, onGalleryUpload, onChat, onHistory, onRetry, previewUrl, logCount, symptom, onSymptomChange, onLogoTap, pillMode, onPillModeChange, onCorrection, capturedImageBase64, currentUser, isGuest, userRole, onLogout, onLoginRequest, onAdmin }) {
  const [selectedPillIdx, setSelectedPillIdx] = useState(0)
  const fileInputRef = useRef(null)
  const [step, setStep] = useState(previewUrl || analysisResult ? 2 : 1)
  const [showCorrection, setShowCorrection] = useState(false)
  const [correctionTarget, setCorrectionTarget] = useState(null)
  const selectedPill = pillResults[selectedPillIdx] || pillResults[0]
useEffect(() => {
  if ((previewUrl || analyzing || mfdsLoading) && step === 1) setStep(2)
}, [previewUrl, analyzing, mfdsLoading, step])

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (file) { onGalleryUpload(file); setStep(2) }
    e.target.value = ''
  }

  const AppHeader = () => (
    <div className="px-5 pt-6 pb-5 bg-gradient-to-b from-[#0192F5] to-[#40BEFD]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => { setStep(1); onLogoTap() }} className="active:scale-90 transition-transform shrink-0" style={{ background:'none', border:'none', padding:0 }}>
            <img src="/logo.png" alt="이거돼?"
              className="object-cover shadow-md"
              style={{ width: 40, height: 40, borderRadius: 12 }}
              onError={e => { e.currentTarget.style.display='none'; e.currentTarget.nextSibling.style.display='flex' }} />
            <div className="items-center justify-center text-2xl"
              style={{ display:'none', width:40, height:40, borderRadius:12, background:'rgba(255,255,255,0.25)' }}>💊</div>
          </button>
          <div>
            <h1 className="text-white font-black text-lg leading-tight">이거 돼?</h1>
            <p className="text-white/70 text-xs">AI 약물 판독 서비스</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 관리자 버튼 (admin만 표시) */}
          {userRole === 'admin' && (
            <button onClick={onAdmin}
              className="w-9 h-9 rounded-2xl bg-white/20 flex items-center justify-center"
              title="관리자 대시보드">
              <Shield size={16} className="text-white" />
            </button>
          )}
          {/* 히스토리 */}
          <button onClick={onHistory}
            className="relative w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center">
            <History size={20} className="text-white" />
            {logCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-400 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                {Math.min(logCount, 9)}
              </span>
            )}
          </button>
          {/* 로그인/로그아웃 */}
          {isGuest ? (
            <button onClick={onLoginRequest}
              className="h-9 px-3 rounded-2xl bg-white text-[#0192F5] text-xs font-black flex items-center gap-1 active:scale-95 transition-transform">
              로그인
            </button>
          ) : (
            <button onClick={onLogout}
              className="w-9 h-9 rounded-2xl bg-white/20 flex items-center justify-center"
              title="로그아웃">
              <LogOut size={16} className="text-white" />
            </button>
          )}
        </div>
      </div>
      {/* 게스트 배너 */}
      {isGuest && (
        <div className="mt-3 bg-white/15 rounded-2xl px-3 py-2 flex items-center gap-2">
          <span className="text-white/80 text-xs">👤 게스트 모드 — 분석 기록이 저장되지 않아요</span>
          <button onClick={onLoginRequest} className="ml-auto text-[10px] font-bold text-white underline shrink-0">
            로그인
          </button>
        </div>
      )}
    </div>
  )

  if (step === 1) {
    return (
      <div className="flex flex-col h-[100dvh]">
        <AppHeader />
        <div className="flex-1 flex flex-col px-5 py-8 space-y-6">
          <div className="text-center space-y-2">
            <div className="text-5xl mb-2">🤒</div>
            <p className="font-black text-slate-800 text-xl">어떤 증상이 있으신가요?</p>
            <p className="text-slate-400 text-sm">증상을 입력하면 더 정확한 분석을 해드려요</p>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-3 bg-slate-50 border-2 border-slate-200 rounded-2xl px-4 py-4 focus-within:border-[#0192F5] transition-colors">
              <input type="text" value={symptom} onChange={e => onSymptomChange(e.target.value)}
                placeholder="예) 두통, 소화불량, 기침, 발열..."
                className="flex-1 bg-transparent text-slate-800 placeholder-slate-400 text-base outline-none"
                onKeyDown={e => e.key === 'Enter' && setStep(2)} autoFocus />
              {symptom && <button onClick={() => onSymptomChange('')} className="text-slate-400"><X size={16} /></button>}
            </div>
            <div className="flex flex-wrap gap-2">
              {['두통', '소화불량', '기침', '발열', '코막힘', '근육통', '복통'].map(s => (
                <button key={s} onClick={() => onSymptomChange(symptom ? symptom + ', ' + s : s)}
                  className="text-sm px-3 py-1.5 rounded-full border border-slate-200 text-slate-600 bg-white active:bg-blue-50 active:border-[#40BEFD] active:text-[#0192F5] transition-all">
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1" />
          <button onClick={() => setStep(2)} className="w-full py-4 rounded-3xl bg-gradient-to-r from-[#0192F5] to-[#40BEFD] text-white font-bold text-base shadow-lg shadow-blue-200 active:scale-95 transition-all">
            {symptom ? '약 사진 찍으러 가기 →' : '증상 없이 바로 찍기 →'}
          </button>
          <p className="text-center text-xs text-slate-300">증상 입력은 선택사항이에요</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[100dvh]">
      <AppHeader />
      {symptom && (
        <div className="px-5 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-2">
          <span className="text-xl">🤒</span>
          <p className="text-base text-[#0192F5] font-bold flex-1 truncate">{symptom}</p>
          <button onClick={() => { onSymptomChange(''); setStep(1) }} className="text-blue-300"><X size={16} /></button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5 pb-28">
        {previewUrl && (
          <div className="relative rounded-3xl overflow-hidden bg-slate-100 aspect-video shadow-md">
            <img src={previewUrl} alt="약품 사진" className="w-full h-full object-cover" />
          </div>
        )}
        {(analyzing || mfdsLoading) && <AnalyzingSkeleton mfdsLoading={mfdsLoading} />}
        {!analyzing && !mfdsLoading && selectedPill && (
          <AnalysisEvidenceCard pill={selectedPill} symptom={symptom} pillCount={pillResults.length} />
        )}
        {!analyzing && !mfdsLoading && getConfidenceBand(selectedPill?.confidence) !== 'blocked' && combinedAnalysis?.drugInteractions?.length > 0 && (
          <InteractionAlertCard interactions={combinedAnalysis.drugInteractions} />
        )}
        {!analyzing && !mfdsLoading && getConfidenceBand(selectedPill?.confidence) !== 'blocked' && durWarnings?.length > 0 && (
          <DurWarningCard warnings={durWarnings} />
        )}
        {!analyzing && !mfdsLoading && pillResults.length > 0 && (
          <PillListCard
            pillResults={pillResults}
            selectedIdx={selectedPillIdx}
            onSelectPill={setSelectedPillIdx}
            onCorrectPill={(idx, pill) => { setCorrectionTarget({ idx, pill }); setShowCorrection(true) }}
          />
        )}
        {!analyzing && !mfdsLoading && pillResults.length === 0 && analysisResult && analysisResult.statusCode === 'unidentified' && (
          <ResultCard result={analysisResult} mfdsInfo={null} onChat={onChat} onRetry={() => { onRetry(); setStep(2) }} />
        )}
        {!analyzing && !mfdsLoading && pillResults.length > 0 && getConfidenceBand(selectedPill?.confidence) !== 'blocked' && (
          <button
            onClick={onChat}
            className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-[#0192F5] to-[#40BEFD] text-white font-bold flex items-center justify-center gap-2 shadow-md active:scale-95 transition-all"
          >
            <MessageCircle size={18} /> AI 약사에게 더 물어보기
          </button>
        )}
        {!previewUrl && !analyzing && !analysisResult && (
          <div className="text-center py-8 space-y-4">
            <div className="w-24 h-24 rounded-full bg-blue-50 flex items-center justify-center mx-auto">
              <Camera size={40} className="text-[#40BEFD]" />
            </div>
            <div className="space-y-1.5">
              <p className="font-bold text-slate-700">약 사진을 찍어주세요</p>
              <p className="text-sm text-slate-400 leading-relaxed">약 봉투, 약통, 낱알 모두 가능해요<br />AI + 식약처 DB로 정확하게 분석해드려요</p>
            </div>
            <div className="mt-6 space-y-2 text-left">
              {[['💊', '약 이름이 보이게 찍으면 더 정확해요'], ['📋', '처방전이나 약 봉투도 인식 가능해요'], ['🔍', '흐리지 않게 가까이서 촬영해주세요'], ['🏥', 'AI 분석 후 식약처 DB에서 공식 정보도 확인해요']].map(([emoji, text], i) => (
                <div key={i} className="flex items-center gap-2.5 bg-slate-50 rounded-2xl px-4 py-2.5">
                  <span className="text-lg">{emoji}</span>
                  <p className="text-xs text-slate-500">{text}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {step === 2 && (
        <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] px-5 pb-8 pt-4 bg-gradient-to-t from-white via-white to-transparent">
          {(analyzing || mfdsLoading || pillResults.length > 0 || (analysisResult && analysisResult.statusCode === 'unidentified')) ? (
            <div className="flex gap-2">
              <button
                onClick={() => { onRetry(); setStep(2) }}
                disabled={analyzing || mfdsLoading}
                className="flex-1 py-4 rounded-2xl bg-slate-100 text-slate-600 font-bold flex items-center justify-center gap-2 disabled:opacity-40"
              >
                <RefreshCw size={18} /> 다시 촬영하기
              </button>
              {!analyzing && !mfdsLoading && pillResults.length > 0 && (
                <button
                  onClick={() => setShowCorrection(true)}
                  className="py-4 px-4 rounded-2xl bg-amber-100 text-amber-700 font-bold flex items-center justify-center gap-1.5 text-sm"
                >
                  ✏️ 정정
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {/* 인식 모드 선택 — 단일약(빠르고 정확) / 여러약(SAM 분리, 베타) */}
              <div className="flex gap-2 p-1 bg-slate-100 rounded-2xl">
                <button
                  onClick={() => onPillModeChange?.('single')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${pillMode !== 'multi' ? 'bg-white text-[#0192F5] shadow' : 'text-slate-500'}`}
                >
                  💊 단일약
                </button>
                <button
                  onClick={() => onPillModeChange?.('multi')}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${pillMode === 'multi' ? 'bg-white text-[#0192F5] shadow' : 'text-slate-500'}`}
                >
                  💊💊 여러 약
                </button>
              </div>
              <div className="flex gap-3">
                <button onClick={() => fileInputRef.current?.click()} className="flex-1 py-4 rounded-2xl bg-slate-100 text-slate-600 font-bold flex items-center justify-center gap-2">
                  <ImagePlus size={20} /> 갤러리
                </button>
                <button onClick={onCameraCapture} className="flex-[2] py-4 rounded-2xl bg-gradient-to-r from-[#0192F5] to-[#40BEFD] text-white font-bold text-base flex items-center justify-center gap-2 shadow-lg shadow-blue-200 active:scale-95 transition-all">
                  <Camera size={22} /> {pillMode === 'multi' ? '여러 약 촬영' : '약 촬영하기'}
                </button>
              </div>
              <p className="text-center text-xs text-slate-400 leading-relaxed">
                💡 <b className="text-slate-500">밝은 곳</b>에서 약을 <b className="text-slate-500">화면에 크게</b>, <b className="text-slate-500">단순한 배경</b>(흰 종이·어두운 바닥) 위에 놓고 찍으면 정확해요
              </p>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
        </div>
      )}
      <CorrectionModal
        isOpen={showCorrection}
        onClose={() => { setShowCorrection(false); setCorrectionTarget(null) }}
        currentImage={capturedImageBase64}
        currentResult={correctionTarget?.pill || selectedPill}
        allPillResults={correctionTarget ? null : pillResults}
        initialIdx={correctionTarget?.idx ?? -1}
        onSubmit={onCorrection}
      />
      <DisclaimerBar />
    </div>
  )
}

// ─── 메인 앱 ─────────────────────────────────────────────────────────────────
export default function App() {
  const [userConditions, setUserConditions] = useState('일반 사용자')
  const [view, setView]           = useState('home')
  const [previewUrl, setPreviewUrl]         = useState(null)
  const [analyzing, setAnalyzing]           = useState(false)
  const [mfdsLoading, setMfdsLoading]       = useState(false)
  const [analysisResult, setAnalysisResult] = useState(null)
  const [mfdsInfo, setMfdsInfo]             = useState(null)
  const [pillResults, setPillResults]       = useState([])
  const [combinedAnalysis, setCombinedAnalysis] = useState(null)
  const [durWarnings, setDurWarnings]       = useState([])
  const [analysisLogs, setAnalysisLogs]     = useState([])
  const [corrections, setCorrections]       = useState([])
  const [allUsers, setAllUsers]             = useState([])
  const [currentUser, setCurrentUser]       = useState(null)   // null = 로딩중
  const [userRole, setUserRole]             = useState('user')
  const [authReady, setAuthReady]           = useState(false)
  const [isGuest, setIsGuest]               = useState(false)
  const [symptom, setSymptom]               = useState('')
  const [pillMode, setPillMode]             = useState('single')  // 'single' | 'multi'
  const [showOnboarding, setShowOnboarding] = useState(!localStorage.getItem('igodae_onboarding_done'))
  const [capturedImageBase64, setCapturedImageBase64] = useState(null)
  const logoTapTimer = useRef(null)
  const [logoTapCount, setLogoTapCount]     = useState(0)

  // ── Auth 상태 구독 ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!auth) { setAuthReady(true); return }
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setCurrentUser(user)
        setIsGuest(false)
        // Firestore에서 role 조회 (없으면 'user')
        try {
          const snap = await getDoc(doc(db, 'users', user.uid))
          if (snap.exists()) {
            setUserRole(snap.data().role || 'user')
            // 마지막 로그인 시간 업데이트
            await updateDoc(doc(db, 'users', user.uid), { lastLogin: serverTimestamp() })
          } else {
            setUserRole('user')
          }
        } catch (e) { console.warn('role 로드 실패:', e.message) }
      } else {
        // 로그아웃 → 게스트 상태도 초기화
        setCurrentUser(null)
        setUserRole('user')
      }
      setAuthReady(true)
    })
    return unsub
  }, [])

  // ── 관리자 계정 자동 생성 + 자동 로그인 (.env에 VITE_ADMIN_EMAIL 있을 때만) ──
  // 딥러닝 담당자용 — 배포 전 .env에서 두 줄 삭제
  useEffect(() => {
    const adminEmail = import.meta.env.VITE_ADMIN_EMAIL
    const adminPw    = import.meta.env.VITE_ADMIN_PASSWORD
    if (!adminEmail || !adminPw || !auth || !db) return

    const loginAdmin = () =>
      signInWithEmailAndPassword(auth, adminEmail, adminPw)
        .then(() => console.log('✅ 관리자 자동 로그인 완료:', adminEmail))
        .catch(e => console.warn('관리자 로그인 실패:', e.message))

    createUserWithEmailAndPassword(auth, adminEmail, adminPw)
      .then(async (cred) => {
        await setDoc(doc(db, 'users', cred.user.uid), {
          email: adminEmail, role: 'admin',
          createdAt: serverTimestamp(), lastLogin: serverTimestamp(),
        })
        console.log('✅ 관리자 계정 자동 생성 완료:', adminEmail)
        // 계정 생성 후 자동 로그인
        await loginAdmin()
      })
      .catch(() => {
        // 이미 계정 존재 → 바로 로그인
        loginAdmin()
      })
  }, [])

  // ── 분석 기록 구독 (로그인 유저만 / 관리자는 전체, 일반은 본인 것) ───────────
  useEffect(() => {
    if (!db || !currentUser || isGuest) { setAnalysisLogs([]); return }
    const q = query(LOGS_PATH(), orderBy('createdAt', 'desc'), limit(200))
    const unsub = onSnapshot(q, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      // 관리자는 전체, 일반 유저는 본인 것만
      setAnalysisLogs(
        userRole === 'admin' ? all : all.filter(log => log.userId === currentUser.uid)
      )
    }, err => console.warn('Firestore 구독 에러:', err.message))
    return unsub
  }, [currentUser, isGuest, userRole])

  // ── 관리자 전용: corrections + 전체 유저 목록 구독 ─────────────────────────
  useEffect(() => {
    if (!db || userRole !== 'admin') { setCorrections([]); setAllUsers([]); return }

    // corrections 실시간
    const q1 = query(CORRECTIONS_PATH(), orderBy('createdAt', 'desc'), limit(50))
    const unsub1 = onSnapshot(q1, snap => {
      setCorrections(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })

    // 전체 유저 목록 (1회 조회)
    const loadUsers = async () => {
      try {
        const snap = await getDocs(USERS_PATH())
        const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
        setAllUsers(users.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)))
      } catch (e) { console.warn('유저 목록 로드 실패:', e.message) }
    }
    loadUsers()

    return () => { unsub1() }
  }, [userRole])

  // ── 이미지 압축 → Base64 변환 (최대 400px, quality 0.6) ─────────────────────
  const compressImageToBase64 = useCallback((blob, maxWidth = 400, quality = 0.6) => {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      const img = new Image()
      img.onload = () => {
        const ratio = Math.min(maxWidth / img.width, 1)
        canvas.width  = Math.round(img.width  * ratio)
        canvas.height = Math.round(img.height * ratio)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.onerror = () => resolve(null)
      img.src = URL.createObjectURL(blob)
    })
  }, [])

  // ── Base64 Firestore 저장 (Storage 미사용) ───────────────────────────────────
  const saveToFirestore = useCallback(async (result, blob) => {
    if (!db || !currentUser || isGuest) return
    try {
      let imageBase64 = null
      if (blob) {
        imageBase64 = await compressImageToBase64(blob)
      }
      await addDoc(LOGS_PATH(), {
        userId:        currentUser.uid,
        statusCode:    result.statusCode,
        statusText:    result.statusText,
        summary:       result.summary,
        confidence:    result.confidence,
        imageBase64:   imageBase64,
        userConditions,
        createdAt:     serverTimestamp(),
      })
    } catch (e) { console.warn('Firestore 저장 실패:', e.message) }
  }, [currentUser, isGuest, userConditions, compressImageToBase64])

  // ── 정정 저장 ────────────────────────────────────────────────────────────────
  const saveCorrection = useCallback(async ({ correctDrugName, originalResult, originalConfidence, image }) => {
    if (!db || !currentUser || isGuest) return
    try {
      await addDoc(CORRECTIONS_PATH(), {
        userId: currentUser.uid,
        correctDrugName, originalResult, originalConfidence,
        imageBase64: image || null,
        createdAt: serverTimestamp(),
      })
    } catch (e) { console.warn('정정 저장 실패:', e.message) }
  }, [currentUser, isGuest])

  // ── 관리자: 유저 role 변경 ───────────────────────────────────────────────────
  const handleUpdateUserRole = useCallback(async (uid, newRole) => {
    try {
      await updateDoc(doc(db, 'users', uid), { role: newRole })
      setAllUsers(prev => prev.map(u => u.uid === uid ? { ...u, role: newRole } : u))
    } catch (e) { console.warn('role 업데이트 실패:', e.message) }
  }, [])

  // ── 이미지 처리 ──────────────────────────────────────────────────────────────
  const processImage = useCallback((file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = e => {
        const dataUrl = e.target.result
        resolve({ base64: dataUrl.split(',')[1], previewUrl: dataUrl })
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }, [])

  const runAnalysis = useCallback(async (base64, mimeType = 'image/jpeg', blob = null, mode = 'single') => {
    setAnalyzing(true)
    setMfdsInfo(null); setAnalysisResult(null); setPillResults([]); setDurWarnings([])
    setCapturedImageBase64(base64)

    let aiResult
    const imageDataUrl = `data:${mimeType};base64,${base64}`

    // ── 인식: 모드별 분기 ──
    //  single = 단일 추론만(SAM 절대 안 탐, 빠름·정확) / multi = SAM으로 여러 약 분리
    if (mode === 'multi') {
      const multiResult = await fetchMultiPillInference(imageDataUrl)
      if (multiResult && multiResult.pillsIdentified >= 1) {
        console.log(`🔬 SAM: ${multiResult.pillsIdentified}개 약 감지`)
        const rawPills = multiResult.results.map(r => {
          const top = r.pills[0]
          const conf = r.confidence
          const confLabel = conf >= 0.75 ? '높음' : conf >= 0.45 ? '보통' : '낮음'
          return {
            drugName: top.drugName,
            color: '', shape: '', form: '', imprint: '', size: '',
            confidence: top.similarity,
            description: `SAM+DL 매칭 (유사도 ${(top.similarity * 100).toFixed(1)}%, 확신도 ${confLabel})`,
            fromDL: true,
            bbox: r.bbox,
          }
        })
        const isSameDrug = (a, b) => {
          const na = a.replace(/\s|\(.*\)/g, ''), nb = b.replace(/\s|\(.*\)/g, '')
          if (na === nb) return true
          const short = Math.min(na.length, nb.length, 4)
          return na.slice(0, short) === nb.slice(0, short)
        }
        const deduped = []
        for (const p of rawPills) {
          const existing = deduped.find(d => isSameDrug(d.drugName, p.drugName))
          if (existing) {
            if (p.confidence > existing.confidence) Object.assign(existing, p)
          } else {
            deduped.push({ ...p })
          }
        }
        const multiPills = deduped
        if (multiPills.length >= 2) {
          aiResult = {
            pills: multiPills,
            totalCount: multiPills.length,
            symptomHint: '',
            dlConfidenceLevel: multiPills[0].confidence >= 0.75 ? '높음' : '보통',
            multiMode: true,
          }
        } else {
          const p = multiPills[0]
          const confLabel = p.confidence >= 0.75 ? '높음' : p.confidence >= 0.45 ? '보통' : '낮음'
          aiResult = { pills: [p], totalCount: 1, symptomHint: '', dlConfidenceLevel: confLabel }
        }
      } else {
        setAnalysisResult({
          statusCode: 'unidentified',
          summary: '약 미인식',
          description: '여러 약이 잘 보이게 다시 촬영하거나, 단일약 모드로 한 알씩 찍어보세요.',
          confidence: 0,
        })
        setAnalyzing(false)
        return
      }
    } else {
      // 단일약 모드: SAM 안 탐, 단일 추론만
      const dlResult = await fetchModelInference(imageDataUrl)
      if (dlResult?.isPill && dlResult.pills?.length > 0) {
        const conf = dlResult.confidence
        const confLabel = conf >= 0.75 ? '높음' : conf >= 0.45 ? '보통' : '낮음'
        console.log(`🧠 DL 단일 매칭 (유사도 ${(conf * 100).toFixed(1)}%, 확신도 ${confLabel})`)
        const topPill = dlResult.pills[0]
        aiResult = {
          pills: [{
            drugName: topPill.drugName,
            color: '', shape: '', form: '', imprint: '', size: '',
            confidence: topPill.similarity,
            description: `DL 모델 매칭 (유사도 ${(topPill.similarity * 100).toFixed(1)}%, 확신도 ${confLabel})`,
            fromDL: true,
          }],
          totalCount: 1,
          symptomHint: '',
          dlConfidenceLevel: confLabel,
        }
      } else if (dlResult && !dlResult.isPill) {
        setAnalysisResult({
          statusCode: 'unidentified',
          summary: '약이 아닙니다',
          description: '실제 약 이미지를 촬영해주세요. (그림, 사탕, 동전 등은 인식되지 않습니다)',
          confidence: 0,
        })
        setAnalyzing(false)
        return
      } else {
        setAnalysisResult({
          statusCode: 'unidentified',
          summary: '분석 실패',
          description: 'AI 모델 서버에 연결되지 않았습니다. 잠시 후 다시 시도하거나 다시 촬영해주세요.',
          confidence: 0,
        })
        setAnalyzing(false)
        return
      }
    }

    setAnalyzing(false)
    if (!aiResult.pills || aiResult.pills.length === 0) {
      setAnalysisResult({ statusCode: 'unidentified', summary: '알약 미인식', description: '알약이 잘 보이도록 다시 촬영해주세요.', confidence: 0 })
      return
    }

    setMfdsLoading(true)
    try {
      const rawResults = await Promise.all(aiResult.pills.map(pill => analyzeSinglePill(pill, aiResult.symptomHint)))
      // 식약처 조회 후 같은 약 dedup (이름 앞 4글자 기준)
      const results = []
      for (const r of rawResults) {
        const rName = (r.summary || '').replace(/\s|\(.*\)/g, '').slice(0, 4)
        const dup = results.find(d => (d.summary || '').replace(/\s|\(.*\)/g, '').slice(0, 4) === rName)
        if (dup) {
          if ((r.confidence || 0) > (dup.confidence || 0)) Object.assign(dup, r)
        } else {
          results.push(r)
        }
      }
      // ── 메인 결과(약 이름+식약처 정보) 즉시 표시 ──
      setPillResults(results); setAnalysisResult(results[0])
      setMfdsLoading(false)

      // ── 종합분석·DUR·저장은 백그라운드 (결과 표시를 막지 않음) ──
      ;(async () => {
        try {
          if (results.length >= 2) {
            setCombinedAnalysis(await analyzePillsCombined(results, symptom))
          }
          const userProfile = {
            isPregnant: userConditions.includes('임신') || userConditions.includes('임부'),
            isElderly:  userConditions.includes('노인') || userConditions.includes('고령'),
          }
          const dur = await runDurCheck(results, userProfile)
          setDurWarnings(dur)
          if (results[0]?.statusCode !== 'unidentified') {
            await saveToFirestore(results[0], blob)
          }
        } catch (e) { console.warn('백그라운드 분석 실패:', e.message) }
      })()
    } catch (e) {
      console.warn('분석 실패:', e.message)
      setMfdsLoading(false)
    }
  }, [userConditions, symptom, saveToFirestore])

  const handleCameraCapture = useCallback(async (blob) => {
    setView('home')
    const { base64, previewUrl } = await processImage(blob)
    setPreviewUrl(previewUrl); setAnalysisResult(null)
    await runAnalysis(base64, 'image/jpeg', blob, pillMode)
  }, [processImage, runAnalysis, pillMode])

  const handleGalleryUpload = useCallback(async (file) => {
    const { base64, previewUrl } = await processImage(file)
    setPreviewUrl(previewUrl); setAnalysisResult(null)
    await runAnalysis(base64, file.type || 'image/jpeg', file, pillMode)
  }, [processImage, runAnalysis, pillMode])








  const handleLogoTap = () => {
    if (view !== 'home') setView('home')
    const next = logoTapCount + 1
    setLogoTapCount(next)
    if (logoTapTimer.current) clearTimeout(logoTapTimer.current)
    logoTapTimer.current = setTimeout(() => setLogoTapCount(0), 2000)
  }

  const handleLogout = async () => {
    try { await signOut(auth) } catch (e) { console.warn('로그아웃 실패:', e.message) }
    // 뷰 및 분석 상태 전체 초기화
    setView('home')
    setIsGuest(false)
    setPreviewUrl(null)
    setAnalysisResult(null)
    setMfdsInfo(null)
    setPillResults([])
    setCombinedAnalysis(null)
    setDurWarnings([])
    setCapturedImageBase64(null)
    setSymptom('')
  }

  // ── 로딩 중 ─────────────────────────────────────────────────────────────────
  if (!authReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-b from-[#0192F5] to-[#40BEFD]">
        <Loader2 className="animate-spin text-white" size={40} />
      </div>
    )
  }

  // ── 미로그인 + 비게스트 → AuthView ──────────────────────────────────────────
  if (!currentUser && !isGuest) {
    return <AuthView onGuest={() => {
      setView('home')
      setPreviewUrl(null)
      setAnalysisResult(null)
      setMfdsInfo(null)
      setPillResults([])
      setCombinedAnalysis(null)
      setDurWarnings([])
      setCapturedImageBase64(null)
      setSymptom('')
      setIsGuest(true)
    }} />
  }

  // ── 온보딩 ──────────────────────────────────────────────────────────────────
  if (showOnboarding) {
    return <OnboardingSlides onComplete={() => { localStorage.setItem('igodae_onboarding_done', 'true'); setShowOnboarding(false) }} />
  }

  // ── 뷰 라우팅 ────────────────────────────────────────────────────────────────
  if (view === 'admin' && userRole === 'admin') {
    return (
      <AdminView
        logs={analysisLogs} corrections={corrections} allUsers={allUsers}
        onBack={() => setView('home')} onUpdateUserRole={handleUpdateUserRole}
      />
    )
  }
  if (view === 'camera') return <CameraView onCapture={handleCameraCapture} onCancel={() => setView('home')} />
  if (view === 'chat' && analysisResult) return <ChatView result={analysisResult} mfdsInfo={mfdsInfo} userConditions={userConditions} onBack={() => setView('home')} />
  if (view === 'history') return (
    <HistoryView
      logs={analysisLogs} isGuest={isGuest}
      onSelect={(log) => {
        setAnalysisResult({ ...log })
        setPillResults([{ ...log }])
        setMfdsInfo(null)
        setPreviewUrl(null)
        setView('home')
      }}
      onBack={() => setView('home')}
      onLoginRequest={() => { setIsGuest(false) }}
    />
  )

  return (
    <>
      <HomeView
        userConditions={userConditions} analysisResult={analysisResult} mfdsInfo={mfdsInfo}
        pillResults={pillResults} combinedAnalysis={combinedAnalysis} durWarnings={durWarnings}
        analyzing={analyzing} mfdsLoading={mfdsLoading}
        onCameraCapture={() => setView('camera')} onGalleryUpload={handleGalleryUpload}
        onChat={() => setView('chat')} onHistory={() => setView('history')}
        onRetry={() => { setPreviewUrl(null); setAnalysisResult(null); setMfdsInfo(null); setPillResults([]); setCombinedAnalysis(null); setDurWarnings([]) }}
        previewUrl={previewUrl} logCount={analysisLogs.length}
        symptom={symptom} onSymptomChange={setSymptom} onLogoTap={handleLogoTap}
        pillMode={pillMode} onPillModeChange={setPillMode}
        onCorrection={saveCorrection} capturedImageBase64={capturedImageBase64}
        /* 새로 추가된 props */
        currentUser={currentUser} isGuest={isGuest} userRole={userRole}
        onLogout={handleLogout} onLoginRequest={() => { setIsGuest(false) }}
        onAdmin={() => setView('admin')}
      />
    </>
  )
}

