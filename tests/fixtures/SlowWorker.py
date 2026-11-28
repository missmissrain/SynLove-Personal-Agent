"""超时测试Worker。无参数；只读取测试输入并等待，不访问网络或业务数据。"""
import sys
import time

sys.stdin.buffer.readline()
time.sleep(60)
