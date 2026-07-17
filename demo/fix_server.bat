@echo off
cd /d E:\ProjBuild\SelfLearn\LinProject\backend
python -c "import sys; data=open('server.py','rb').read(); old=b'    log(f\"Interactive sim:'; new=b'    try:\n        bridge.engine.eval(\"ops=find_system(''\"+model+\"'', ''BlockType'', ''Outport''); for i=1:length(ops), set_param(ops{i}, ''DataLogging'', ''on''); end; clear ops\", nargout=0)\n    except Exception:\n        pass\n    log(f\"Interactive sim:'; data=data.replace(old,new,1); open('server.py','wb').write(data); print('OK')"
