// src/App.js
import React, { useState } from "react";
import SrtParser from "srt-parser-2";
import "./styles.css";

// --- 核心配置 ---
const BATCH_SIZE = 25; 

export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [srtFile, setSrtFile] = useState(null);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [finalSrt, setFinalSrt] = useState(null);
  
  // ⚡️ 修复：使用带版本号的精确名称，避免 404
  const [selectedModel, setSelectedModel] = useState("gemini-1.5-flash-002");

  const parser = new SrtParser();

  const addLog = (msg) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);
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

  const callGeminiWithRetry = async (fullPrompt, retries = 5) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;

    const safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];

    for (let i = 0; i < retries; i++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            safetySettings: safetySettings,
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8192,
            },
          }),
        });

        if (response.status === 429) {
          const waitTime = 20000 + (i * 10000); 
          addLog(`⚠️ 触发限流 (429)，休息 ${waitTime / 1000} 秒...`);
          await sleep(waitTime);
          if (i === retries - 1) throw new Error("限流重试次数耗尽");
          continue;
        }

        if (response.status === 503) {
          addLog(`⚠️ 服务器繁忙 (503)，等待 10 秒...`);
          await sleep(10000);
          continue;
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `API 报错: ${response.status} - ${errorData.error?.message || "未知错误"}`
          );
        }

        const data = await response.json();

        if (
          data.candidates &&
          data.candidates.length > 0 &&
          data.candidates[0].content &&
          data.candidates[0].content.parts
        ) {
          return data.candidates[0].content.parts[0].text;
        } else {
          let reason = "未知原因";
          if (data.candidates && data.candidates.length > 0) {
            reason = data.candidates[0].finishReason || "未知";
          } else if (data.promptFeedback) {
            reason = `Prompt被拦截 (${data.promptFeedback.blockReason})`;
          }
          throw new Error(`API 拒绝生成 (原因: ${reason})`);
        }
      } catch (error) {
        if (i === retries - 1) throw error;
        addLog(`❌ 请求出错 (${error.message})，重试中...`);
        await sleep(5000);
      }
    }
    throw new Error("请求逻辑异常终止");
  };

  const processSrt = async () => {
    if (!apiKey) return alert("请先输入 Google API Key");
    if (!srtFile) return alert("请上传 SRT 文件");
    if (!scriptText) return alert("请粘贴参考讲稿");

    setIsProcessing(true);
    setLogs([]); 
    addLog(`🚀 启动修正 | 模型: ${selectedModel}`);
    
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

        addLog(`正在处理第 ${batchIndex} / ${totalBatches} 批...`);

        const fullPrompt = `你是一个专业的字幕校对专家。
任务：利用【参考讲稿】来检测并修复【待修正字幕】。

【核心处理法则 (严格执行)】：
1. **标点符号特殊处理（空格模式）**：
   - **逗号（，）**：**必须替换为空格**。严禁直接删除导致文字粘连，必须用空格隔开。
   - **句号（。）/感叹号（！）**：如果在句中，替换为空格；如果在句尾，可以直接删除。
   - **问号（？）**：如果讲稿中是问句，**必须保留**问号。
2. **去除语助词**：强制删除“呢、哈、啊、嘛、那个”等无意义口语词。
3. **保留原话**：在满足上述规则的前提下，尽量保留字幕原本的口语表达。
4. **修正错别字**：仅修正同音错字。
5. **强制简体中文**：输出结果必须严格转换为**简体中文**。

【输出要求】：
1. 必须输出 ${currentBatch.length} 行，不要遗漏。
2. 格式：序号>>>修正后的文本。
3. 严禁输出解释。

【参考讲稿片段】：
${scriptText.slice(0, 3000)}...

【待修正字幕】：
${textBlock}
`;

        const resultText = await callGeminiWithRetry(fullPrompt);

        if (!resultText || typeof resultText !== "string") {
          throw new Error("API 返回数据格式无效");
        }

        const fixedLinesMap = {};
        resultText.split("\n").forEach((line) => {
          if (line.includes(">>>")) {
            const parts = line.split(">>>");
            const idx = parts[0].trim();
            const txt = parts.slice(1).join(">>>").trim();
            fixedLinesMap[idx] = txt;
          }
        });

        const safeBatch = currentBatch.map((item, idx) => {
          const key = (idx + 1).toString();
          return {
            ...item,
            text: fixedLinesMap[key] || item.text,
          };
        });

        processedArray = [...processedArray, ...safeBatch];
        setProgress(Math.round((batchIndex / totalBatches) * 100));

        if (batchIndex < totalBatches) {
          await sleep(4000); 
        }
      }

      const finalString = parser.toSrt(processedArray);
      setFinalSrt(finalString);
      addLog("🎉 全部完成！");
      setIsProcessing(false);
    } catch (error) {
      console.error(error);
      addLog(`❌ 严重错误: ${error.message}`);
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
      <h1>🎬 字幕修正器 (v3.0)</h1>
      <p className="subtitle">精确模型版本 | 解决 404 错误</p>

      <div className="section">
        <label className="section-title">1. Google API 设置</label>
        <input
          type="password"
          placeholder="在此输入你的 Google API Key (AIzaSy...)"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        
        <label className="section-title" style={{marginTop: '15px'}}>🤖 选择模型 (已更新版本号)</label>
        <select 
          value={selectedModel} 
          onChange={(e) => setSelectedModel(e.target.value)}
          style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc' }}
        >
          {/* 使用精确的 -002 或 -001 后缀，而不是别名，这样 API 一定能找到 */}
          <option value="gemini-1.5-flash-002">Gemini 1.5 Flash-002 (最新稳定版)</option>
          <option value="gemini-1.5-flash-001">Gemini 1.5 Flash-001 (旧稳定版)</option>
          <option value="gemini-1.5-flash-8b">Gemini 1.5 Flash-8b (极速版)</option>
        </select>
      </div>

      <div className="section">
        <label className="section-title">2. 参考讲稿</label>
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