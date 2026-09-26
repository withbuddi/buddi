/**
 * Public suffixes a wildcard binding may not sit on (docs/owner-secrets.md §3).
 *
 * Provenance: hand-picked on 2026-09-26 from the Public Suffix List
 * (https://publicsuffix.org/list/public_suffix_list.dat): the most used
 * multi-label entries of its ICANN section, plus the common private ones where
 * anyone can get a subdomain (github.io, pages.dev, vercel.app, …). It is
 * bundled, never fetched at run time, and deliberately short: every
 * single-label suffix (a TLD such as com or uk) is refused by rule, so no TLD
 * is listed, and a suffix missing here only means the owner could bind a
 * pattern a little wider than the list would have allowed — the suffix stays
 * fixed and the card still names the real origin. `*.x` entries follow the
 * list's own wildcard rules: every name directly under x is a public suffix.
 *
 * No imports: the dashboard reads this file too.
 */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // ICANN: United Kingdom, Ireland, Europe
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk', 'mod.uk',
  'gov.ie',
  'co.at', 'or.at', 'ac.at', 'gv.at',
  'com.pl', 'net.pl', 'org.pl', 'info.pl', 'biz.pl', 'edu.pl', 'gov.pl', 'waw.pl',
  'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es',
  'com.pt', 'org.pt', 'gov.pt', 'edu.pt',
  'com.gr', 'org.gr', 'net.gr', 'edu.gr', 'gov.gr',
  'com.cy', 'org.cy', 'net.cy', 'gov.cy', 'ac.cy',
  'com.mt', 'org.mt', 'net.mt', 'edu.mt', 'gov.mt',
  'co.hu', 'org.hu', 'info.hu',
  'com.ro', 'org.ro', 'info.ro', 'nom.ro',
  'co.rs', 'org.rs', 'edu.rs', 'gov.rs', 'in.rs',
  'com.ua', 'org.ua', 'net.ua', 'gov.ua', 'edu.ua', 'in.ua', 'kiev.ua',
  'com.ru', 'org.ru', 'net.ru', 'msk.ru', 'spb.ru',
  'co.no', 'priv.no',
  'com.hr', 'from.hr', 'iz.hr', 'name.hr',
  'co.it', 'gov.it', 'edu.it',
  'asso.fr', 'com.fr', 'gouv.fr', 'nom.fr', 'prd.fr', 'tm.fr',
  'co.je', 'net.je', 'org.je', 'co.gg', 'net.gg', 'org.gg', 'co.im', 'net.im', 'org.im',
  // ICANN: North America
  'gc.ca', 'on.ca', 'qc.ca', 'bc.ca', 'ab.ca',
  'com.mx', 'org.mx', 'net.mx', 'edu.mx', 'gob.mx',
  'ny.us', 'ca.us', 'tx.us', 'fl.us', 'wa.us', 'k12.ca.us', 'lib.ca.us',
  // ICANN: Latin America and the Caribbean
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br', 'blog.br', 'eco.br', 'emp.br', 'ind.br', 'inf.br', 'tv.br', 'app.br', 'dev.br',
  'com.ar', 'org.ar', 'net.ar', 'gob.ar', 'edu.ar', 'int.ar', 'tur.ar',
  'com.co', 'org.co', 'net.co', 'edu.co', 'gov.co', 'nom.co',
  'com.pe', 'org.pe', 'net.pe', 'gob.pe', 'edu.pe', 'nom.pe',
  'com.ve', 'org.ve', 'net.ve', 'gob.ve', 'co.ve',
  'com.uy', 'org.uy', 'net.uy', 'gub.uy', 'edu.uy',
  'com.ec', 'org.ec', 'net.ec', 'gob.ec', 'edu.ec', 'fin.ec',
  'com.bo', 'org.bo', 'net.bo', 'gob.bo', 'edu.bo',
  'com.py', 'org.py', 'net.py', 'gov.py', 'edu.py',
  'gob.cl', 'gov.cl', 'co.cl',
  'com.do', 'org.do', 'net.do', 'gob.do', 'edu.do',
  'com.gt', 'org.gt', 'net.gt', 'gob.gt', 'edu.gt',
  'co.cr', 'or.cr', 'fi.cr', 'go.cr', 'ac.cr',
  'com.pa', 'org.pa', 'net.pa', 'gob.pa',
  'com.sv', 'org.sv', 'gob.sv', 'edu.sv',
  'com.ni', 'org.ni', 'gob.ni',
  'com.hn', 'org.hn', 'net.hn', 'gob.hn',
  'com.cu', 'org.cu', 'net.cu', 'gob.cu',
  'com.jm', 'org.jm', 'net.jm', 'gov.jm',
  'com.tt', 'org.tt', 'net.tt', 'gov.tt', 'co.tt',
  'com.pr', 'org.pr', 'net.pr', 'gov.pr',
  // ICANN: Asia and Oceania
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz', 'school.nz', 'geek.nz', 'gen.nz', 'kiwi.nz', 'maori.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr', 'pe.kr',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'res.in', 'nic.in',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg', 'per.sg',
  'com.my', 'net.my', 'org.my', 'edu.my', 'gov.my', 'name.my',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'my.id', 'biz.id', 'net.id', 'sch.id',
  'co.th', 'in.th', 'ac.th', 'go.th', 'or.th', 'net.th',
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn',
  'com.ph', 'net.ph', 'org.ph', 'edu.ph', 'gov.ph',
  'com.pk', 'net.pk', 'org.pk', 'edu.pk', 'gov.pk',
  'com.bd', 'org.bd', 'net.bd', 'gov.bd', 'edu.bd',
  'com.lk', 'org.lk', 'gov.lk', 'edu.lk',
  'com.np', 'org.np', 'gov.np', 'edu.np',
  'com.kh', 'org.kh', 'gov.kh',
  'com.mm', 'org.mm', 'gov.mm',
  'com.fj', 'org.fj', 'gov.fj', 'ac.fj',
  'com.pg', 'org.pg', 'gov.pg', 'ac.pg',
  'com.kz', 'org.kz', 'gov.kz', 'edu.kz',
  // ICANN: Middle East and Africa
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'gen.tr', 'biz.tr', 'info.tr', 'av.tr', 'bel.tr', 'k12.tr',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'muni.il',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa', 'med.sa',
  'co.ae', 'net.ae', 'org.ae', 'gov.ae', 'ac.ae',
  'com.qa', 'org.qa', 'net.qa', 'gov.qa', 'edu.qa',
  'com.kw', 'org.kw', 'net.kw', 'gov.kw', 'edu.kw',
  'com.bh', 'org.bh', 'net.bh', 'gov.bh', 'edu.bh',
  'com.om', 'org.om', 'net.om', 'gov.om', 'co.om',
  'com.jo', 'org.jo', 'net.jo', 'gov.jo', 'edu.jo',
  'com.lb', 'org.lb', 'net.lb', 'gov.lb', 'edu.lb',
  'com.eg', 'org.eg', 'net.eg', 'gov.eg', 'edu.eg', 'eun.eg',
  'co.ir', 'ac.ir', 'gov.ir', 'org.ir', 'net.ir',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'web.za', 'edu.za', 'nom.za',
  'com.ng', 'org.ng', 'net.ng', 'gov.ng', 'edu.ng', 'name.ng',
  'co.ke', 'or.ke', 'ne.ke', 'go.ke', 'ac.ke', 'sc.ke',
  'co.tz', 'or.tz', 'ne.tz', 'go.tz', 'ac.tz',
  'co.ug', 'or.ug', 'ne.ug', 'go.ug', 'ac.ug',
  'com.gh', 'org.gh', 'gov.gh', 'edu.gh',
  'co.ma', 'net.ma', 'org.ma', 'gov.ma', 'ac.ma', 'press.ma',
  'com.tn', 'org.tn', 'gov.tn', 'ens.tn', 'fin.tn',
  'com.dz', 'org.dz', 'net.dz', 'gov.dz', 'edu.dz',
  'com.et', 'org.et', 'gov.et', 'edu.et',
  'co.zw', 'org.zw', 'gov.zw', 'ac.zw',
  'co.zm', 'org.zm', 'gov.zm', 'ac.zm',
  'co.bw', 'org.bw', 'ac.bw',
  'com.na', 'org.na', 'co.na',
  'co.mz', 'org.mz', 'gov.mz',
  'com.cm', 'co.cm', 'net.cm', 'gov.cm',
  'com.sn', 'org.sn', 'edu.sn', 'gouv.sn',
  'com.ci', 'co.ci', 'or.ci', 'go.ci', 'ac.ci',
  'com.tg', 'gouv.tg',
  'co.rw', 'gov.rw', 'ac.rw',
  // ICANN wildcard rules: every name directly under these is a public suffix.
  '*.ck', '*.er', '*.fk', '*.jm', '*.kh', '*.mm', '*.np', '*.pg', '*.bd',
  // Private: anyone can get a name directly under these.
  'github.io', 'githubusercontent.com', 'gitlab.io', 'bitbucket.io',
  'pages.dev', 'workers.dev', 'trycloudflare.com',
  'vercel.app', 'vercel.dev', 'now.sh',
  'netlify.app', 'netlify.com',
  'herokuapp.com', 'herokussl.com',
  'cloudfront.net', 'amazonaws.com', 's3.amazonaws.com', 'elasticbeanstalk.com', 'awsapprunner.com', 'amplifyapp.com',
  'azurewebsites.net', 'azurestaticapps.net', 'cloudapp.net', 'azureedge.net', 'azurefd.net', 'blob.core.windows.net', 'trafficmanager.net',
  'appspot.com', 'firebaseapp.com', 'web.app', 'run.app', 'cloudfunctions.net', 'blogspot.com',
  'fly.dev', 'onrender.com', 'up.railway.app', 'deno.dev', 'deno.net', 'glitch.me', 'repl.co', 'replit.dev', 'replit.app',
  'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'ngrok.dev', 'ngrok-free.dev',
  'surge.sh', 'readthedocs.io', 'myshopify.com', 'wixsite.com', 'webflow.io', 'framer.app', 'framer.website',
  'ondigitalocean.app', 'digitaloceanspaces.com', 'supabase.co', 'fastly.net', 'global.ssl.fastly.net', 'edgecompute.app',
  'duckdns.org', 'dyndns.org', 'ddns.net', 'no-ip.org', 'hopto.org', 'zapto.org', 'eu.org', 'us.org',
  'neocities.org', 'codeberg.page', 'sourceforge.io', 'pythonanywhere.com', 'streamlit.app', 'hf.space',
]);

/**
 * Whether a host is a public suffix: listed, under a listed `*.` rule, or a
 * single label (every TLD is one). A host a wildcard binding would sit on
 * must be none of these.
 */
export function isPublicSuffix(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (!name.includes('.')) return true;
  if (PUBLIC_SUFFIXES.has(name)) return true;
  const parent = name.slice(name.indexOf('.') + 1);
  return PUBLIC_SUFFIXES.has(`*.${parent}`);
}
