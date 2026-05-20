/** Vercel Serverless Function: 接收H5安检数据 → 写入飞书多维表格 */
const https = require('https');

const APP_TOKEN = 'Xrt8bvRXKadOcaswKHMcSCyynsb';
const TABLE_ID = 'tblQ2B62uRxCQzff';

// 飞书字段名映射：H5 key → 飞书字段名
const FIELD_MAP = {
  g1: 'g1_气密性', g2: 'g2_灶具燃烧工况', g3: 'g3_火盖状态',
  g4: 'g4_燃气软管外观', g5: 'g5_燃气软管使用年限', g6: 'g6_灶具使用年限',
  g7: 'g7_灶具熄火保护', g8: 'g8_燃气报警器',
  e1: 'e1_电源线', e2: 'e2_插座', e3: 'e3_漏电保护', e4: 'e4_接地保护',
  w1: 'w1_进水管', w2: 'w2_排水管', w3: 'w3_水压',
  s1: 's1_烟管密封性', s2: 's2_烟机使用年限', s3: 's3_油烟机运行',
  s4: 's4_烟机风速', s5: 's5_止逆阀', s6: 's6_油网清洁',
  q1: 'q1_水质外观', q2: 'q2_TDS值', q3: 'q3_净水器滤芯',
  q4: 'q4_净水器运行', q5: 'q5_热水器运行', q6: 'q6_橱柜环境',
};

// GKEYS → 飞书前缀映射
const DK_PREFIX = { gas: 'g', elec: 'e', water: 'w', smoke: 's', wqual: 'q' };

function getTenantToken() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    });
    const req = https.request({
      hostname: 'open.feishu.cn', path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const j = JSON.parse(data);
        if (j.code === 0) resolve(j.tenant_access_token);
        else reject(new Error(`Token failed: ${j.msg}`));
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function callFeishu(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };
    if (b) headers['Content-Length'] = Buffer.byteLength(b);
    const req = https.request({ hostname: 'open.feishu.cn', path, method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (b) req.write(b); req.end();
  });
}

/** 格式化检测项值为可读文本 */
function formatItemVal(val, extra) {
  if (val === 'bad') {
    const reason = extra || '';
    return '异常' + (reason ? '：' + reason : '');
  }
  if (val === 'ok') return '正常';
  if (!val && val !== 0) return '未检测';
  return String(val);
}

/** 判断是否异常 */
function isBad(val) {
  return val === 'bad';
}

function mapFields(data) {
  const f = {};
  const c = data.c || {};
  const st = data.st || {};

  f['消费者姓名'] = c.n || '';
  f['消费者电话'] = c.p || '';
  f['消费者地址'] = c.cm || '';
  f['门店名称'] = st.n || '';
  f['服务人员'] = c.st || '';
  f['服务日期'] = c.dt ? Date.parse(c.dt) : Date.now();

  let badCount = 0;

  // 遍历 5 个分组
  for (const [gk, dk] of Object.entries({ gas: 'g', elec: 'e', water: 'w', smoke: 's', wqual: 'q' })) {
    const dd = data[dk] || {};
    for (const [key, val] of Object.entries(dd)) {
      if (key.endsWith('_r') || key.endsWith('_val') || key.endsWith('_label')) continue;
      const feishuField = FIELD_MAP[key];
      if (!feishuField) continue;
      const reason = dd[key + '_r'] || '';
      f[feishuField] = formatItemVal(val, reason);
      if (isBad(val)) badCount++;
    }
  }

  f['异常项数'] = badCount;
  f['整体评估'] = badCount === 0 ? '✅ 全部正常' : `⚠️ 发现 ${badCount} 处问题`;
  f['报告链接'] = data._url || '';
  f['生成时间'] = new Date().toISOString();
  f['记录ID'] = `INSP-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

  return f;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, msg: '只支持 POST' });

  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', async () => {
    try {
      const data = JSON.parse(raw);
      if (!data || !data.v || !data.c) return res.status(400).json({ ok: false, msg: '数据格式错误' });
      if (!process.env.FEISHU_APP_ID) return res.status(500).json({ ok: false, msg: 'FEISHU_APP_ID 未配置' });

      const token = await getTenantToken();
      const fields = mapFields(data);
      const result = await callFeishu('POST',
        `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
        token, { fields }
      );

      if (result.code === 0) {
        return res.status(200).json({
          ok: true, record_id: result.data?.record?.record_id || '',
          msg: '✅ 已上报飞书', link: `https://bytedance.feishu.cn/base/${APP_TOKEN}?table=${TABLE_ID}`
        });
      }
      return res.status(500).json({ ok: false, msg: `飞书写入失败: ${result.msg}`, code: result.code });
    } catch (e) {
      return res.status(500).json({ ok: false, msg: `服务器错误: ${e.message}` });
    }
  });
};
