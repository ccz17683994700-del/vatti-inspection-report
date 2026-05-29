// Vercel Serverless Function: /api/openboom.js
// 华帝开业爆量 · 飞书Bitable代理
// 挂载于 vatti-inspection-report Vercel 项目

const https = require('https');

const APP_TOKEN='***';
const MAIN_TABLE = 'tblEcvffkhT3dLRb';

function feishuRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'open.feishu.cn',
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + token,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getToken() {
  const resp = await feishuRequest('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: process.env.FEISHU_APP_ID,
    app_secret: process.env.FEISHU_APP_SECRET,
  });
  return resp.tenant_access_token;
}

async function lookupStore(storeCode, token) {
  const filter = encodeURIComponent(`CurrentValue.[门店编号]="${storeCode}"`);
  const path = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${MAIN_TABLE}/records?page_size=5&filter=${filter}`;
  const resp = await feishuRequest('GET', path, null, token);
  if (resp.code !== 0) throw new Error('查询失败: ' + (resp.msg || 'unknown'));
  const items = resp.data?.items || [];
  if (items.length === 0) return { found: false };
  const f = items[0].fields;
  return {
    found: true,
    recordId: items[0].record_id,
    fields: {
      storeName: f['门店名称'] || '',
      region: f['所属区域'] || '',
      dealer: f['所属一级经销商'] || '',
      buildType: f['建店属性'] || '',
      planDate: f['计划开业日期(N)'] ? String(f['计划开业日期(N)']).slice(0,10) : '',
      target: f['开业目标(万)'] || 0,
      pmName: f['项目主控'] || '',
      docPlan: f['方案资料提交'] || '未提交',
      docPhoto: f['落地照片提交'] || '未提交',
      docDMS: f['DMS数据提交'] || '未提交',
      docReview: f['复盘资料提交'] || '未提交',
      docRecord: f['备案资料提交'] || '未提交',
      progress: f['最新进展'] || '',
      nextStep: f['下一步动作'] || '',
      submitter: f['区域填报人'] || '',
    }
  };
}

async function getNextProjectId(token) {
  const path = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${MAIN_TABLE}/records?page_size=500`;
  const resp = await feishuRequest('GET', path, null, token);
  if (resp.code !== 0) return 'KY2026-001';
  const items = resp.data?.items || [];
  let maxNum = 0;
  items.forEach(item => {
    const pid = item.fields?.['项目编号'];
    if (pid && pid.startsWith('KY2026-')) {
      const num = parseInt(pid.replace('KY2026-', ''), 10);
      if (num > maxNum) maxNum = num;
    }
  });
  return 'KY2026-' + String(maxNum + 1).padStart(3, '0');
}

async function submitProject(data, token) {
  const { storeCode, fields } = data;
  const now = new Date().toISOString().slice(0, 10);
  const lookup = await lookupStore(storeCode, token);
  const flowType = fields.flowType;

  const feishuFields = {
    '门店编号': storeCode,
    '门店名称': fields.storeName,
    '所属区域': fields.region,
    '所属一级经销商': fields.dealer,
    '建店属性': fields.buildType,
    '计划开业日期(N)': fields.planDate ? new Date(fields.planDate + 'T00:00:00').getTime() : null,
    '开业目标(万)': fields.target,
    '项目主控': fields.pmName,
    '流程类型': flowType,
    '方案资料提交': flowType === '标准开业流程' ? (fields.docPlan || '未提交') : '不适用',
    '落地照片提交': flowType === '标准开业流程' ? (fields.docPhoto || '未提交') : '不适用',
    'DMS数据提交': flowType === '标准开业流程' ? (fields.docDMS || '未提交') : '不适用',
    '复盘资料提交': flowType === '标准开业流程' ? (fields.docReview || '未提交') : '不适用',
    '备案资料提交': flowType === '备案流程' ? (fields.docRecord || '未提交') : '不适用',
    '最新进展': fields.progress || '',
    '下一步动作': fields.nextStep || '',
    '区域填报人': fields.submitter,
    '最近填报时间': new Date(now + 'T00:00:00').getTime(),
  };

  const requiredDocs = flowType === '标准开业流程'
    ? ['方案资料提交', '落地照片提交', 'DMS数据提交', '复盘资料提交']
    : ['备案资料提交'];
  const missing = requiredDocs.filter(d => feishuFields[d] === '未提交');
  feishuFields['资料完整性'] = missing.length === 0 ? '完整' : '待补充（' + missing.length + '项）';

  if (lookup.found) {
    const path = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${MAIN_TABLE}/records/${lookup.recordId}`;
    const resp = await feishuRequest('PUT', path, { fields: feishuFields }, token);
    if (resp.code !== 0) throw new Error('更新失败: ' + (resp.msg || 'unknown'));
    return { ok: true, recordId: lookup.recordId, action: 'updated', flowType };
  } else {
    const projectId = await getNextProjectId(token);
    feishuFields['项目编号'] = projectId;
    feishuFields['建店申请时间'] = new Date(now + 'T00:00:00').getTime();
    const path = `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${MAIN_TABLE}/records`;
    const resp = await feishuRequest('POST', path, { fields: feishuFields }, token);
    if (resp.code !== 0) throw new Error('创建失败: ' + (resp.msg || 'unknown'));
    return { ok: true, recordId: resp.data?.record?.record_id || 'unknown', action: 'created', projectId, flowType };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const token = await getToken();

    if (req.method === 'GET') {
      const { searchParams } = new URL(req.url, 'https://vatti-inspection-report.vercel.app');
      const action = searchParams.get('action');
      const store = searchParams.get('store');
      if (action === 'lookup' && store) {
        const result = await lookupStore(store, token);
        res.status(200).json({ ok: true, ...result });
      } else {
        res.status(400).json({ ok: false, error: 'Use action=lookup&store=CODE' });
      }
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (data.action === 'submit') {
            const result = await submitProject(data, token);
            res.status(200).json(result);
          } else {
            res.status(400).json({ ok: false, error: 'Use action=submit' });
          }
        } catch(e) {
          res.status(500).json({ ok: false, error: e.message });
        }
      });
    }
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
