// src/App.js
import React, { useState } from "react";
import SrtParser from "srt-parser-2";
import "./styles.css";

// --- 核心配置 ---
// 1. 批处理大小：75 行
const BATCH_SIZE = 75;
// 2. 模型锁定：gemini-flash-latest
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

  // --- 核心请求函数 (含安全设置与重试) ---
  const callGeminiWithRetry = async (fullPrompt, retries = 3) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

    // 强制关闭安全拦截 (这是解决 "API 返回数据异常" 的关键)
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
            safetySettings: safetySettings, // 注入安全设置
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 4096,
            },
          }),
        });

        if (response.status === 429) {
          addLog(`⚠️ 触发限流 (429)，等待 20 秒...`);
          await sleep(20000);
          continue;
        }

        if (!response.ok) {
          if (response.status === 503) {
            addLog(`⚠️ 服务器忙 (503)，等待 5 秒...`);
            await sleep(5000);
            continue;
          }
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            `API 报错: ${response.status} - ${errorData.error?.message}`
          );
        }

        const data = await response.json();
        
        // --- 增强的错误诊断 ---
        if (
          data.candidates &&
          data.candidates.length > 0 &&
          data.candidates[0].content &&
          data.candidates[0].content.parts
        ) {
          return data.candidates[0].content.parts[0].text;
        } else {
          // 如果没有内容，检查 finishReason
          let reason = "未知原因";
          if (data.candidates && data.candidates.length > 0) {
            reason = data.candidates[0].finishReason || "未知";
          } else if (data.promptFeedback) {
            reason = `Prompt被拦截 (${data.promptFeedback.blockReason})`;
          }
          
          console.error("API 数据异常详情:", JSON.stringify(data, null, 2));
          throw new Error(`API 拒绝生成 (原因: ${reason}) - 请检查控制台`);
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
    addLog(`🚀 启动空格分词模式 | 模型: ${MODEL_NAME}`);
    addLog(`规则: 逗号变空格 | 仅留问号 | 去口癖 | 强制简中`);
    addLog(`🛡️ 安全策略: 已设置为 BLOCK_NONE (防止误杀)`);

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
          `正在处理第 ${batchIndex} / ${totalBatches} 批...`
        );

        // --- 🚀 PROMPT 更新：增加强制简中逻辑 ---
        const fullPrompt = `你是一个专业的字幕校对专家。
任务：利用【参考讲稿】来检测并修复【待修正字幕】。

【核心处理法则 (严格执行)】：
1. **标点符号特殊处理（空格模式）**：
   - **逗号（，）**：**必须替换为空格**。严禁直接删除导致文字粘连，必须用空格隔开（例如："你好，我来了" -> "你好 我来了"）。
   - **句号（。）/感叹号（！）**：如果在句中，替换为空格；如果在句尾，可以直接删除。
   - **问号（？）**：如果讲稿中是问句，**必须保留**问号。
2. **去除语助词**：强制删除“呢、哈、啊、嘛、那个”等无意义口语词。
3. **保留原话**：在满足上述规则的前提下，尽量保留字幕原本的口语表达。
4. **修正错别字**：仅修正同音错字（如“起托”->“解脱”）。
5. **强制简体中文**：无论输入字幕或讲稿是繁体或英文，输出结果必须严格转换为**简体中文**。

【判定示例 (Few-Shot)】：
- 情况A (逗号变空格)：
  讲稿: "你好，我来了。"
  字幕: "你好，我来了"
  -> 修正: 你好 我来了 (逗号变成了空格)
- 情况B (去口癖 + 逗号变空格)：
  讲稿: "大家都知道，这件事很难。"
  字幕: "大家呢，都知道哈，这件事啊，很难。"
  -> 修正: 大家都知道 这件事很难 (去除了呢/哈/啊，逗号变成了空格)
- 情况C (保留问号)：
  讲稿: "你吃饭了吗？"
  字幕: "你吃饭了吗"
  -> 修正: 你吃饭了吗？
- 情况D (强制简中)：
  讲稿: "這是正確的。"
  字幕: "這是正確的"
  -> 修正: 这是正确的

【输出要求】：
1. 必须输出 ${currentBatch.length} 行。
2. 格式：序号>>>修正后的文本。
3. 严禁输出解释。

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

        if (batchIndex < totalBatches) {
          await sleep(3000);
        }
      }

      const finalString = parser.toSrt(processedArray);
      setFinalSrt(finalString);
      addLog("🎉 清洗完成！(逗号已变空格)");
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
      <h1>🎬 字幕修正器 (空格分词版)</h1>
      <p className="subtitle">Model: {MODEL_NAME} | 逗号变空格 | 仅留问号</p>

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
        <label className="section-title">2. 参考讲稿 (用于上下文校对)</label>
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