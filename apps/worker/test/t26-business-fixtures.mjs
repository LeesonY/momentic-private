// T26 local-only deterministic business workflows. The frozen business
// oracle compares the exact computed result, not the existence of a marker.
// These are eight independently seeded application rules, not eight labels
// on the same generic order form. No external writes or user information.
export const T26_FIXTURES = Object.freeze([
  {
    id: 'inventory-reservation',
    title: '仓库库存预留',
    field: 'sku',
    fieldLabel: '商品 SKU',
    value: 'SKU-42',
    first: '查询库存',
    second: '确认预留',
    expected: 'SKU-42：已预留2件，剩余3件',
    wrong: 'SKU-42：已预留2件，剩余5件',
    compute: `const stock = new Map([['SKU-42',5],['SKU-73',1]]);
      return stock.has(v) && stock.get(v) >= 2
        ? v + '：已预留2件，剩余' + (stock.get(v)-2) + '件'
        : '库存不足';`,
  },
  {
    id: 'coupon-discount',
    title: '促销券折扣计算',
    field: 'coupon',
    fieldLabel: '优惠券编码',
    value: 'SAVE20',
    first: '校验优惠券',
    second: '应用折扣',
    expected: '订单原价100元，优惠20元，应付80元',
    wrong: '订单原价100元，优惠20元，应付100元',
    compute: `const coupons = {'SAVE20':0.2, 'SAVE10':0.1};
      const rate = coupons[v] ?? 0;
      return '订单原价100元，优惠' + (100*rate) +
        '元，应付' + (100*(1-rate)) + '元';`,
  },
  {
    id: 'shipping-service-zone',
    title: '邮编配送分区',
    field: 'zipcode',
    fieldLabel: '收货邮编',
    value: '410001',
    first: '识别配送区域',
    second: '确认运费',
    expected: '邮编410001：长沙市区，同城配送费8元',
    wrong: '邮编410001：长沙市区，同城配送费18元',
    compute: `const zones = new Map([['410001',{area:'长沙市区',fee:8}],
        ['410200',{area:'远郊',fee:18}]]);
      const zone = zones.get(v);
      return zone ? '邮编' + v + '：' + zone.area +
        '，同城配送费' + zone.fee + '元' : '超出配送范围';`,
  },
  {
    id: 'meeting-slot',
    title: '会议室时段预约',
    field: 'slot',
    fieldLabel: '预约时段',
    value: '09:30',
    first: '检查会议室空档',
    second: '锁定预约',
    expected: '会议室A：09:30预约成功',
    wrong: '会议室A：09:30时段已被占用',
    compute: `const occupied = new Set(['09:00','11:00']);
      return occupied.has(v) ? '会议室A：' + v +
        '时段已被占用' : '会议室A：' + v + '预约成功';`,
  },
  {
    id: 'invoice-vat',
    layoutFamily: 'fieldset_with_sidebar',
    title: '企业增值税发票计算',
    field: 'invoice',
    fieldLabel: '企业纳税号',
    value: '913100001',
    first: '核验税号',
    second: '计算发票税额',
    expected: '税号913100001：不含税金额200元，税额26元',
    wrong: '税号913100001：不含税金额200元，税额12元',
    compute: `const valid = /^91[0-9]{7}$/.test(v);
      return valid ? '税号' + v +
        '：不含税金额200元，税额' + Math.round(200*0.13) +
        '元' : '企业税号格式错误';`,
  },
  {
    id: 'support-priority',
    layoutFamily: 'navigation_and_grouped_article',
    title: '工单优先级分流',
    field: 'ticket',
    fieldLabel: '支持工单编号',
    value: 'INC-2048',
    first: '查询告警等级',
    second: '分配支持队列',
    expected: 'INC-2048：P1级告警，分派紧急支持队列',
    wrong: 'INC-2048：P1级告警，分派普通支持队列',
    compute: `const alarms = new Map([['INC-2048','P1'],['INC-1050','P3']]);
      const priority = alarms.get(v);
      return priority ? v + '：' + priority +
        '级告警，分派' + (priority === 'P1' ? '紧急' : '普通') +
        '支持队列' : '工单不存在';`,
  },
  {
    id: 'room-upgrade',
    layoutFamily: 'data_table',
    title: '酒店房型升级库存校验',
    field: 'room',
    fieldLabel: '拟升级房型',
    value: 'M2',
    first: '查询可升级房型',
    second: '确认房型升级',
    expected: 'M2房型：升级成功，剩余1间',
    wrong: 'M2房型：升级成功，剩余2间',
    compute: `const rooms = new Map([['M2',2],['M3',0]]);
      const available = rooms.get(v) ?? 0;
      return available > 0 ? v + '房型：升级成功，剩余' +
        (available - 1) + '间' : '无可用房型';`,
  },
  {
    id: 'cart-quantity',
    layoutFamily: 'list_with_summary_aside',
    title: '购物车数量与小计',
    field: 'quantity',
    fieldLabel: '商品购买数量',
    value: '3',
    first: '计算商品小计',
    second: '确认购物车',
    expected: '单价40元，数量3件，小计120元',
    wrong: '单价40元，数量3件，小计80元',
    compute: `const quantity = Number(v);
      return Number.isInteger(quantity) && quantity > 0 && quantity <= 20
        ? '单价40元，数量' + quantity + '件，小计' +
          (40*quantity) + '元' : '商品数量无效';`,
  },
]);

export function getT26Fixture(id) {
  const flow = T26_FIXTURES.find((candidate) => candidate.id === id);
  if (!flow) throw new Error('T26_UNKNOWN_BUSINESS_FLOW');
  return flow;
}

// No DOM element with an arbitrary success marker: both healthy and
// mutation pages contain the same result test-id, so presence-only oracles
// would incorrectly mark a faulty business calculation as successful.
export function renderT26Fixture(flow, faulty, variant = 'historical') {
  if (
    ![
      'historical',
      't33-dialog',
      't34-iframe',
      't34-shadow',
      't36-frame-reload',
      't36-shadow-remount',
    ].includes(variant)
  )
    throw new Error('UNAPPROVED_LOCAL_FIXTURE_VARIANT');
  if (variant === 't33-dialog' && flow.id !== 'support-priority')
    throw new Error('UNAPPROVED_LOCAL_FIXTURE_FLOW');
  if (
    (['t34-iframe', 't36-frame-reload'].includes(variant) &&
      flow.id !== 'support-priority') ||
    (['t34-shadow', 't36-shadow-remount'].includes(variant) &&
      flow.id !== 'room-upgrade')
  )
    throw new Error('UNAPPROVED_LOCAL_FIXTURE_FLOW');
  const data = {
    field: flow.field,
    first: flow.first,
    second: flow.second,
    expected: flow.expected,
    wrong: flow.wrong,
    faulty,
    variant,
  };
  // Distinct DOM families for T32 G3 coverage; business oracles, two
  // human-approved buttons and deterministic field locators do not change.
  // The four original T26 pages retain their historical simple form layout
  // so T31 results remain comparable. These four are different real
  // browser accessibility/DOM structures, not extra labels on one page.
  const field = `<label>${flow.fieldLabel}<input data-testid="${flow.field}" aria-label="${flow.fieldLabel}" type="text"></label>`;
  const start = `<button type="button" id="start" aria-label="${flow.first}">${flow.first}</button>`;
  const result = '<section id="result" aria-live="polite">尚未操作</section>';
  const layouts = {
    'invoice-vat': `<header><p>发票开具台</p></header>
      <div class="invoice-columns"><aside aria-label="开票说明"><p>企业开票资料核验</p></aside>
      <section aria-label="税额计算表单"><form onsubmit="return false"><fieldset>
      <legend>纳税主体</legend>${field}</fieldset><div class="actions">${start}</div>
      </form></section></div><article aria-label="开票核验结果">${result}</article>`,
    'support-priority': `<nav aria-label="服务台导航"><ol><li>查询告警</li><li>分流工单</li></ol></nav>
      <article aria-label="工单分流面板"><header><h2>事件告警</h2></header>
      <form onsubmit="return false"><div role="group" aria-label="工单检索">${field}</div>
      <div role="group" aria-label="支持操作">${start}</div></form>
      <footer><p>工单优先级结果</p>${result}</footer></article>`,
    'room-upgrade': `<section aria-label="酒店房型库存"><h2>可升级客房核验</h2>
      <form onsubmit="return false"><table aria-label="房型升级办理"><thead>
      <tr><th scope="col">房型</th><th scope="col">操作</th></tr></thead>
      <tbody><tr><td>${field}</td><td>${start}</td></tr></tbody></table></form>
      <div class="upgrade-result" role="region" aria-label="升级结果">${result}</div></section>`,
    'cart-quantity': `<header><h2>购物车核算</h2></header>
      <div class="cart-page"><section aria-label="购物车商品"><ol>
      <li><form onsubmit="return false">${field}</form></li>
      <li><div role="group" aria-label="商品小计操作">${start}</div></li></ol></section>
      <aside aria-label="购物车总计"><h3>小计确认</h3>${result}</aside></div>`,
  };
  if (variant === 't33-dialog') {
    layouts['support-priority'] =
      `<nav aria-label="工单处理流程"><ol><li>查询工单</li><li>确认分派</li></ol></nav>
      <details open aria-label="工单检索折叠面板"><summary>展开工单检索</summary>
      <form onsubmit="return false"><fieldset><legend>告警检索资料</legend>${field}</fieldset>
      <div role="group" aria-label="告警处理">${start}</div></form></details>
      <dialog id="confirmation" aria-label="工单优先级确认对话框">
      <h2>人工批准的第二步确认</h2>${result}</dialog>`;
  }
  if (variant === 't34-iframe' || variant === 't36-frame-reload') {
    layouts['support-priority'] =
      `<section aria-label="跨 Frame 工单分派"><h2>工单检索</h2>
        <form onsubmit="return false">${field}${start}</form>
        <iframe name="t34-approval" title="同源动态工单确认面板"
          ${variant === 't36-frame-reload' ? 'srcdoc="<p>旧审核文档</p>"' : ''}></iframe>
        ${result}</section>`;
  }
  if (variant === 't34-shadow' || variant === 't36-shadow-remount') {
    layouts['room-upgrade'] =
      `<section aria-label="房型升级 Web Components"><h2>可用房型</h2>
        <form onsubmit="return false">${field}${start}</form>
        <div id="shadow-host" aria-label="动态 Web Component 批准面板"></div>
        ${result}</section>`;
  }
  const body =
    layouts[flow.id] ??
    `<form onsubmit="return false">${field}${start}${result}</form>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${flow.title}</title></head>
    <body><main><h1>${flow.title}</h1>${body}</main>
    <script>
    const fixture=${JSON.stringify(data)};
    const confirmation=document.getElementById('confirmation');
    const calculate=(v)=>{${flow.compute}};
    document.getElementById('start').addEventListener('click',()=>{
      const v=document.querySelector('[data-testid="'+fixture.field+'"]').value;
      const actual=calculate(v);
      const region=document.getElementById('result');
      if(actual !== fixture.expected) {region.textContent='输入数据无效'; return;}
      const next=document.createElement('button');
      next.type='button'; next.textContent=fixture.second;
      next.setAttribute('aria-label',fixture.second);
      next.addEventListener('click',()=>{
        const result=document.createElement('p');
        result.setAttribute('data-testid','complete-marker');
        result.textContent=fixture.faulty?fixture.wrong:actual;
        region.replaceChildren(result);
      },{once:true});
      if (fixture.variant === 't34-iframe') {
        setTimeout(() => {
          const frame=document.querySelector('iframe[name="t34-approval"]');
          frame.contentDocument.body.replaceChildren(next);
        }, 120);
      } else if (fixture.variant === 't36-frame-reload') {
        const frame=document.querySelector('iframe[name="t34-approval"]');
        frame.addEventListener('load', () => {
          setTimeout(() => {
            if(frame.contentDocument?.body) frame.contentDocument.body.replaceChildren(next);
          }, 180);
        }, {once:true});
        frame.srcdoc='<html><body data-t36-document="new"><p>新的同源审核文档</p></body></html>';
      } else if (fixture.variant === 't34-shadow') {
        setTimeout(() => {
          const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});
          const inner=document.createElement('div');
          root.append(inner);
          inner.attachShadow({mode:'open'}).append(next);
        }, 120);
      } else if (fixture.variant === 't36-shadow-remount') {
        const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});
        const retired=document.createElement('div');
        retired.textContent='旧房型组件将被重新挂载';
        root.append(retired);
        setTimeout(() => {
          const replacement=document.createElement('section');
          const nested=document.createElement('div');
          replacement.append(nested);
          nested.attachShadow({mode:'open'}).append(next);
          root.replaceChildren(replacement);
        }, 180);
      } else {
        region.replaceChildren(next);
      }
      if (confirmation && !confirmation.open) confirmation.showModal();
    },{once:true});
    </script></body></html>`;
}
