#!/usr/bin/env python3
"""Собирает materials.json: для каждой папки презентера берёт PDF с самой свежей датой
последнего коммита. Запускается автоматически при каждой публикации сайта."""
import json, os, subprocess, sys
root = sys.argv[1] if len(sys.argv) > 1 else '.'
out = sys.argv[2] if len(sys.argv) > 2 else 'materials.json'
base = os.path.join(root, 'presenters')
best = {}
for dp, _, fs in os.walk(base):
    for f in fs:
        if not f.lower().endswith('.pdf'):
            continue
        full = os.path.join(dp, f)
        rel = os.path.relpath(full, root).replace(os.sep, '/')
        folder = os.path.relpath(dp, base).replace(os.sep, '/')
        if folder == '.':
            continue
        r = subprocess.run(['git', '-C', root, 'log', '-1', '--format=%cI', '--', rel], capture_output=True, text=True)
        when = r.stdout.strip()
        if not when:
            continue
        size = os.path.getsize(full)
        if not size:
            continue
        cur = best.get(folder)
        if not cur or (when, f) > (cur['updated'], cur['file']):
            best[folder] = {'file': rel, 'updated': when, 'size': size}
json.dump(best, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
print('materials.json:', {k: (v['file'], v['updated']) for k, v in best.items()})
