import os
nm = r'E:\ProjBuild\SelfLearn\LinProject\electron-app\node_modules'
total, count = 0, 0
for root, dirs, files in os.walk(nm):
    for f in files:
        total += os.path.getsize(os.path.join(root, f))
        count += 1
print(f"{count} files, {total/1024/1024:.0f} MB")
