// api/mfds-proxy.js
// Vercel Serverless Function — 식약처 API CORS 프록시
// 브라우저에서 직접 호출 시 CORS 에러 발생 → 이 함수가 서버에서 대신 호출

export default async function handler(req, res) {
  // CORS 헤더 허용
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  const { endpoint, ...params } = req.query

  // 허용된 엔드포인트만 프록시
  const ALLOWED_ENDPOINTS = {
    drugInfo:   'https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList',
    pillInfo:   'https://apis.data.go.kr/1471000/MdcinGrnIdntfcInfoService03/getMdcinGrnIdntfcInfoList03',
    permission: 'https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService07/getDrugPrdtPrmsnDtlInq06',
    durCombination: 'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getUsjntTabooInfoList03',
    durPregnancy:   'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getPwnmTabooInfoList03',
    durElderly:     'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getOdsnAtentInfoList03',
    durDuplicate:   'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getEfcyDplctInfoList03',
  }

  const targetBase = ALLOWED_ENDPOINTS[endpoint]
  if (!targetBase) {
    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })
  }

  // 식약처 API 키는 서버 환경변수에서 주입 (VITE_ prefix 없이 저장 권장)
  const isDur = endpoint?.startsWith('dur')
  const serviceKey = isDur
    ? (process.env.DUR_API_KEY || process.env.MFDS_API_KEY || process.env.VITE_MFDS_API_KEY)
    : (process.env.MFDS_API_KEY || process.env.VITE_MFDS_API_KEY)
  if (!serviceKey) {
    return res.status(500).json({ error: 'MFDS_API_KEY not configured' })
  }

  try {
    const query = new URLSearchParams({ ...params, serviceKey, type: 'json' })
    const upstream = `${targetBase}?${query}`

    // 식약처 API가 느릴 때 Vercel 함수 타임아웃(→502) 방지: 7초 후 중단
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 7000)
    let data
    try {
      const response = await fetch(upstream, { signal: ctrl.signal })
      const text = await response.text()
      // 비JSON(권한없음 시 XML 에러 등) → response.json() 터지지 않게 안전 파싱
      try { data = JSON.parse(text) }
      catch { data = { body: { items: [] }, _nonjson: true } }
    } finally {
      clearTimeout(timer)
    }
    return res.status(200).json(data)
  } catch (err) {
    // 타임아웃·네트워크 실패 → 502 대신 빈 결과(200)로 반환해 UI가 안 깨지게
    console.error('mfds-proxy error:', err.message)
    return res.status(200).json({ body: { items: [] }, _error: err.message })
  }
}
