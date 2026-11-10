#!/usr/bin/env python3
"""Cleans the solar-companies workbook: de-obfuscates emails, repairs shifted rows and typos, validates, de-duplicates,
normalises state and company names. Usage: clean_leads.py INPUT.xlsx OUTPUT_DIR"""
import sys, re, csv, collections, os
import openpyxl

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)

STATES = {  # canonical state names, keyed by upper-case source spelling
 'ANDHRA PRADESH':'Andhra Pradesh','ARUNACHAL PRADESH':'Arunachal Pradesh','ASSAM':'Assam','BIHAR':'Bihar','CHHATTISGARH':'Chhattisgarh','GOA':'Goa','GUJARAT':'Gujarat',
 'HARYANA':'Haryana','HIMACHAL PRADESH':'Himachal Pradesh','JHARKHAND':'Jharkhand','KARNATAKA':'Karnataka','KERALA':'Kerala','MADHYA PRADESH':'Madhya Pradesh',
 'MAHARASHTRA':'Maharashtra','MANIPUR':'Manipur','MEGHALAYA':'Meghalaya','MIZORAM':'Mizoram','NAGALAND':'Nagaland','ODISHA':'Odisha','ORISSA':'Odisha','PUNJAB':'Punjab',
 'RAJASTHAN':'Rajasthan','SIKKIM':'Sikkim','TAMIL NADU':'Tamil Nadu','TELANGANA':'Telangana','TRIPURA':'Tripura','UTTAR PRADESH':'Uttar Pradesh','UTTARAKHAND':'Uttarakhand',
 'WEST BENGAL':'West Bengal','NCT OF DELHI':'Delhi','DELHI':'Delhi','CHANDIGARH':'Chandigarh','PUDUCHERRY':'Puducherry','LADAKH':'Ladakh','LAKSHADWEEP':'Lakshadweep',
 'JAMMU AND KASHMIR':'Jammu & Kashmir','JAMMU & KASHMIR':'Jammu & Kashmir','ANDAMAN AND NICOBAR ISLANDS':'Andaman & Nicobar Islands',
 'THE DADRA AND NAGAR HAVELI AND DAMAN AND DIU':'Dadra & Nagar Haveli and Daman & Diu','DADRA AND NAGAR HAVELI AND DAMAN AND DIU':'Dadra & Nagar Haveli and Daman & Diu',
}
def state_of(s):
    k = re.sub(r'\s+', ' ', str(s or '')).strip().upper()
    return STATES.get(k)

DOMAIN_FIX = {'gmial.com':'gmail.com','gamil.com':'gmail.com','gmai.com':'gmail.com','gmail.con':'gmail.com','gmail.cm':'gmail.com','gmail.co':'gmail.com','gmaill.com':'gmail.com',
 'gmail.comm':'gmail.com','gmail.om':'gmail.com','gmil.com':'gmail.com','yahoo.con':'yahoo.com','yaho.com':'yahoo.com','yahoo.co':'yahoo.com','hotmail.con':'hotmail.com',
 'outlook.con':'outlook.com','rediffmail.con':'rediffmail.com','gmail':'gmail.com','yahoo':'yahoo.com','hotmail':'hotmail.com','outlook':'outlook.com','rediffmail':'rediffmail.com'}
FREE = {'gmail.com','yahoo.com','yahoo.co.in','yahoo.in','hotmail.com','outlook.com','rediffmail.com','live.com','icloud.com','ymail.com','protonmail.com','aol.com','msn.com'}
GENERIC = re.compile(r'^(info|contact|sales|enquiry|inquiry|admin|support|mail|office|hello|service|services|marketing|care|customercare|accounts|hr|billing)$')
JUNK = re.compile(r'(\.(png|jpg|jpeg|gif|svg|webp)$|^(test|example|noreply|no-reply|donotreply)@|@(example|test|sentry|wixpress)\.)', re.I)
EMAIL_ANY = re.compile(r"[A-Za-z0-9._%+&'-]+@[A-Za-z0-9.-]+(?:\.[A-Za-z]{2,})?")
STRICT = re.compile(r"^[a-z0-9]+(?:[._%+'-][a-z0-9]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$")

def deob(s):
    s = str(s or '')
    s = re.sub(r'\s*[\[\(\{]\s*at\s*[\]\)\}]\s*', '@', s, flags=re.I)
    s = re.sub(r'\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*', '.', s, flags=re.I)
    s = re.sub(r'^\s*e-?\s*mail\s*(id)?\s*[:\-]\s*', '', s, flags=re.I)
    return s

ACR = {'LLP','OPC','LLC','PV','HVAC','EPC','UPS','LED','IOT','AMC','CCTV','BESS','MNRE','II','III','IV','RE','IT','AC','DC','HP','KW','MW','KV','MSME','GST','USA','UK','UAE','NTPC','BHEL','BMS','SPV','IPP','CPP','EV','DG','LPG','CNG','SBI','ICT','R&D','HR'}
def title_company(name):
    n = re.sub(r'\s+', ' ', str(name or '')).strip(' ,.;- ')
    n = re.sub(r'^(m/s\.?|messrs\.?)\s+', '', n, flags=re.I)
    if not n: return ''
    if n != n.upper(): return n  # already mixed case: trust it
    out = []
    for w in n.split(' '):
        base = w.strip('.,()')
        up = base.upper()
        if up in ('PVT','PVT.'): out.append('Pvt')
        elif up in ('LTD','LTD.'): out.append('Ltd')
        elif up in ACR: out.append(w.replace(base, up))
        elif '-' in w: out.append('-'.join(p.capitalize() for p in w.split('-')))
        elif "'" in w: out.append(w.capitalize())
        else: out.append(w.capitalize() if w not in ('&',) else w)
    s = ' '.join(out)
    s = re.sub(r'\bPvt\.?\s+Ltd\.?', 'Pvt Ltd', s)
    s = re.sub(r'\bPrivate Limited\b', 'Private Limited', s)
    return s

removed = []   # (reason, email_or_text, company, state, sheet)
leads = collections.OrderedDict()  # email -> info

def add(email_raw, company, state, sheet):
    e = email_raw.strip().strip('.,;:<>()[]"\'').lower()
    e = re.sub(r'\s+', '', e)
    if '@' not in e: removed.append(('no email address', email_raw, company, state, sheet)); return
    local, dom = e.rsplit('@', 1)
    dom = DOMAIN_FIX.get(dom, dom)
    fixed = (local + '@' + dom) != e
    e = local + '@' + dom
    if JUNK.search(e): removed.append(('junk address', e, company, state, sheet)); return
    if not STRICT.match(e): removed.append(('invalid format', e, company, state, sheet)); return
    d = leads.setdefault(e, {'companies': collections.Counter(), 'states': collections.Counter(), 'sheets': set(), 'fixed': False, 'rows': 0})
    d['rows'] += 1; d['sheets'].add(sheet); d['fixed'] = d['fixed'] or fixed
    if company: d['companies'][company] += 1
    if state: d['states'][state] += 1

wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
# --- Sheet 1: raw list, obfuscated emails, some rows shifted by a column, a repeated header row
raw_rows = 0
for r in list(wb.worksheets[0].iter_rows(values_only=True))[1:]:
    cells = [c for c in r if c not in (None, '')]
    if not cells: continue
    raw_rows += 1
    text = [str(c).strip() for c in cells]
    if any(re.fullmatch(r'\.?\s*no\.?|state|vendor name|email', t, re.I) for t in text): removed.append(('repeated header row', ' | '.join(text), '', '', 'raw list')); continue
    st = next((state_of(t) for t in text if state_of(t)), None)
    em = next((t for t in text if '@' in deob(t)), None)
    comp = ''
    for t in text:
        if t is em or state_of(t) or re.fullmatch(r'\d+(\.0)?', t): continue
        if len(t) > len(comp): comp = t
    if em is None: removed.append(('no email address', ' | '.join(text), comp, st or '', 'raw list')); continue
    found = EMAIL_ANY.findall(deob(em)) or [deob(em)]
    for e in found: add(e, title_company(comp), st, 'raw list')
# --- Sheet 2 / 3: already plain emails
for si, (name, ci, ei, sti) in enumerate([('email only', 2, 3, 1), ('short list', None, 1, None)], start=1):
    ws = wb.worksheets[si]
    for r in list(ws.iter_rows(values_only=True))[1:]:
        if not any(r): continue
        em = str(r[ei] or ''); comp = title_company(r[ci]) if ci is not None and r[ci] else ''
        st = state_of(r[sti]) if sti is not None else None
        for e in (EMAIL_ANY.findall(deob(em)) or [em]): add(e, comp, st, name)

rows = []
for e, d in leads.items():
    dom = e.split('@')[1]; local = e.split('@')[0]
    kind = 'generic' if GENERIC.match(re.sub(r'[\d._-]+$', '', local)) else ('free' if dom in FREE else 'business')
    rows.append({'email': e, 'name': '', 'company': (d['companies'].most_common(1) or [('', 0)])[0][0], 'state': (d['states'].most_common(1) or [('', 0)])[0][0],
                 'email_type': kind, 'tags': 'solar-india,' + kind + '-email', 'in_sheets': ', '.join(sorted(d['sheets'])), 'repaired': 'yes' if d['fixed'] else ''})
rows.sort(key=lambda x: (x['state'] or 'zzz', x['company'].lower(), x['email']))

with open(os.path.join(OUT, 'solar_companies_india_clean.csv'), 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.writer(f, quoting=csv.QUOTE_MINIMAL); w.writerow(['email', 'name', 'company', 'state', 'tags'])
    for r in rows: w.writerow([r['email'], r['name'], r['company'], r['state'], r['tags']])

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
o = Workbook(); ws = o.active; ws.title = 'Clean list'
hdr = ['Email', 'Company', 'State', 'Email type', 'Repaired', 'Found in']
ws.append(hdr)
for r in rows: ws.append([r['email'], r['company'], r['state'], r['email_type'], r['repaired'], r['in_sheets']])
for c in ws[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = PatternFill('solid', fgColor='4F46E5')
ws.freeze_panes = 'A2'; ws.auto_filter.ref = ws.dimensions
for col, wd in zip('ABCDEF', (38, 48, 24, 12, 10, 22)): ws.column_dimensions[col].width = wd
byst = collections.Counter(r['state'] or '(unknown)' for r in rows); bykind = collections.Counter(r['email_type'] for r in rows)
s2 = o.create_sheet('By state'); s2.append(['State', 'Emails']); [s2.append([k, v]) for k, v in byst.most_common()]
s2.append([]); s2.append(['Email type', 'Count']); [s2.append([k, v]) for k, v in bykind.most_common()]
for c in s2[1]: c.font = Font(bold=True)
s2.column_dimensions['A'].width = 46
s3 = o.create_sheet('Removed'); s3.append(['Reason', 'Value', 'Company', 'State', 'Source sheet']); [s3.append(list(x)) for x in removed]
for c in s3[1]: c.font = Font(bold=True)
for col, wd in zip('ABCDE', (22, 60, 40, 20, 14)): s3.column_dimensions[col].width = wd
o.save(os.path.join(OUT, 'solar_companies_india_clean.xlsx'))

print('raw list rows:', raw_rows)
print('unique valid emails:', len(rows), ' removed entries:', len(removed), collections.Counter(x[0] for x in removed))
print('repaired addresses:', sum(1 for r in rows if r['repaired']))
print('email types:', dict(bykind)); print('with company:', sum(1 for r in rows if r['company']), ' with state:', sum(1 for r in rows if r['state']))
print('states:', dict(byst.most_common(40)))
