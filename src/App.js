// src/App.js
import React, { useState } from "react";
import SrtParser from "srt-parser-2";
import "./styles.css";

// --- 核心配置调整 ---
// 1. 降维打击：从 300 改回 75，确保单次请求不被 Google 判定为“体积过大”
const BATCH_SIZE = 75;
// 2. 救星模型：你在截图中拥有的这个别名，通常指向配额最宽裕的 1.5 Flash 版本
const MODEL_NAME = "gemini-flash-latest";

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [srtFile, setSrtFile] = useState(null);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [finalSrt, setFinalSrt] = useState(null);

  const parser = new SrtParser();

  const addLog = (msg) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const handleFileChange = (e) => {
    if (e.target.files[0]) {
      setSrtFile(e.target.files[0]);
      addLog(`已选择文件: ${e.target.files[0].name}`);
      setFinalSrt(null);
      setProgress(0);
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- 核心请求函数 (带指数退避重试) ---
  const callGeminiWithRetry = async (fullPrompt, retries = 3) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: {
              temperature: 0.1,
              // 不需要极端的 8192，常用的 4096 足够处理 75 行，且更安全
              maxOutputTokens: 4096,
            },
          }),
        });

        // 429 错误处理
        if (response.status === 429) {
          addLog(`⚠️ 触发频率限制 (429)，等待 20 秒...`); // 既然是小包，等待时间缩短
          await sleep(20000);
          continue;
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          // 如果是 503 (服务暂时过载)，也值得重试
          if (response.status === 503) {
            addLog(`⚠️ 服务器繁忙 (503)，等待 5 秒...`);
            await sleep(5000);
            continue;
          }
          throw new Error(
            `API 报错: ${response.status} - ${errorData.error?.message}`
          );
        }

        const data = await response.json();
        if (
          data.candidates &&
          data.candidates[0].content &&
          data.candidates[0].content.parts
        ) {
          return data.candidates[0].content.parts[0].text;
        } else {
          throw new Error("数据结构异常");
        }
      } catch (error) {
        if (i === retries - 1) throw error;
        addLog(`❌ 请求出错 (${error.message})，重试中...`);
        await sleep(5000);
      }
    }
  };

  const processSrt = async () => {
    if (!apiKey) return alert("请先输入 Google API Key");
    if (!srtFile) return alert("请上传 SRT 文件");
    if (!scriptText) return alert("请粘贴参考讲稿");

    setIsProcessing(true);
    setLogs([]);
    addLog(`🚀 启动稳健模式 | 模型: ${MODEL_NAME}`);
    addLog(`策略: 每批 ${BATCH_SIZE} 行 | 智能避开限额`);

    try {
      const fileText = await readFileAsText(srtFile);
      const srtArray = parser.fromSrt(fileText);
      addLog(`解析成功: 共 ${srtArray.length} 条字幕`);

      if (srtArray.length === 0) throw new Error("SRT 文件为空");

      let processedArray = [];
      const totalBatches = Math.ceil(srtArray.length / BATCH_SIZE);

      for (let i = 0; i < srtArray.length; i += BATCH_SIZE) {
        const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
        const currentBatch = srtArray.slice(i, i + BATCH_SIZE);

        const textBlock = currentBatch
          .map((item, idx) => `${idx + 1}>>>${item.text}`)
          .join("\n");

        addLog(
          `正在处理第 ${batchIndex} / ${totalBatches} 批 (共 ${currentBatch.length} 行)...`
        );

        const fullPrompt = `你是一个校对助手。
任务：根据以下【参考讲稿】修正【待修正字幕】中的错别字。

【严格规则】：
1. 强制使用简体中文。
2. 绝对不要修改行数，输入 ${currentBatch.length} 行，必须输出 ${
          currentBatch.length
        } 行。
3. 保持格式：序号>>>修正后的文本。
4. 不要改变原意，只改错字。
5. 不要输出任何开场白或结束语。

【参考讲稿片段】：
${scriptText.slice(0, 4000)}... 

【待修正字幕】：
${textBlock}
`;

        const resultText = await callGeminiWithRetry(fullPrompt);

        const fixedLinesMap = {};
        resultText.split("\n").forEach((line) => {
          if (line.includes(">>>")) {
            const parts = line.split(">>>");
            const idx = parts[0].trim();
            const txt = parts.slice(1).join(">>>").trim();
            fixedLinesMap[idx] = txt;
          }
        });

        // 缝合逻辑
        const safeBatch = currentBatch.map((item, idx) => {
          const key = (idx + 1).toString();
          return {
            ...item,
            text: fixedLinesMap[key] || item.text,
          };
        });

        processedArray = [...processedArray, ...safeBatch];
        setProgress(Math.round((batchIndex / totalBatches) * 100));

        // 冷却策略：75行处理很快，我们稍微休息 3 秒即可
        if (batchIndex < totalBatches) {
          await sleep(3000);
        }
      }

      const finalString = parser.toSrt(processedArray);
      setFinalSrt(finalString);
      addLog("🎉 修正完成！");
      setIsProcessing(false);
    } catch (error) {
      console.error(error);
      addLog(`❌ 失败: ${error.message}`);
      setIsProcessing(false);
      alert("处理中断: " + error.message);
    }
  };

  const readFileAsText = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  };

  const downloadFile = () => {
    const blob = new Blob([finalSrt], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fixed_" + (srtFile ? srtFile.name : "subtitle.srt");
    a.click();
  };

  return (
    <div className="container">
      <h1>🎬 字幕修正器 (稳健版)</h1>
      <p className="subtitle">Model: {MODEL_NAME} | 75行/批 | 避开限额</p>

      <div className="section">
        <label className="section-title">1. Google API 设置</label>
        <input
          type="password"
          placeholder="在此输入你的 Google API Key (AIzaSy...)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className="section">
        <label className="section-title">2. 参考讲稿 (用于校对上下文)</label>
        <textarea
          placeholder="在此粘贴正确的讲稿内容..."
          value={scriptText}
          onChange={(e) => setScriptText(e.target.value)}
        />
      </div>

      <div className="section">
        <label className="section-title">3. 上传 SRT 字幕文件</label>
        <div className="file-drop">
          {srtFile ? (
            <div>✅ 已加载: {srtFile.name}</div>
          ) : (
            <>
              <p>点击选择文件</p>
              <input type="file" accept=".srt" onChange={handleFileChange} />
            </>
          )}
        </div>
      </div>

      <div className="section">
        <label className="section-title">4. 执行与日志</label>

        {isProcessing && (
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progress}%` }}
            ></div>
          </div>
        )}

        <div className="log-box">
          {logs.length === 0
            ? "等待开始..."
            : logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>

        <div style={{ marginTop: "20px", display: "flex", gap: "10px" }}>
          {!finalSrt ? (
            <button onClick={processSrt} disabled={isProcessing}>
              {isProcessing ? "修正中..." : "🚀 开始修正"}
            </button>
          ) : (
            <button className="download-btn" onClick={downloadFile}>
              📥 下载修正后的 SRT
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
