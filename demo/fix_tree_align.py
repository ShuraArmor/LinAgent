path = r'E:\ProjBuild\SelfLearn\LinProject\electron-app\src\App.css'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

old = """  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.tree-item .badge {
  margin-left: auto;"""

new = """  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 0;
  width: 42px;
  text-align: center;
  display: inline-block;
}

.tree-item .item-name {
  flex: 1;
}

.tree-item .port-info {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
  font-family: var(--font-mono);
}

.tree-item .badge {
  margin-left: 6px;"""

c = c.replace(old, new, 1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(c)

# verify
v = open(path, 'r', encoding='utf-8').read()
ok = 'width: 42px' in v and 'item-name' in v and 'port-info' in v
print(f'OK={ok}')
