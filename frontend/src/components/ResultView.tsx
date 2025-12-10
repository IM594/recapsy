import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, FileText } from "lucide-react";

interface ResultViewProps {
  result: {
    summary: {
      summary: string;
      achievements: string[];
      challenges: string[];
      nextSteps: string[];
    };
    outputPath: string;
    threadId: string;
  };
}

export function ResultView({ result }: ResultViewProps) {
  const { summary, outputPath } = result;

  const handleCopy = () => {
    const text = `
# 工作总结

## 📊 今日概览
${summary.summary}

## 🎯 主要成就
${summary.achievements.map((item) => `- ${item}`).join("\n")}

## 💪 遇到的挑战
${summary.challenges.map((item) => `- ${item}`).join("\n")}

## 📅 明日计划
${summary.nextSteps.map((item) => `- ${item}`).join("\n")}
    `.trim();

    navigator.clipboard.writeText(text);
    alert("已复制到剪贴板");
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Card className="border-green-200 bg-green-50/50">
        <CardContent className="pt-6 flex items-center gap-4">
          <CheckCircle2 className="h-8 w-8 text-green-600" />
          <div>
            <h3 className="font-semibold text-green-900">生成成功！</h3>
            <p className="text-sm text-green-700">
              Markdown 文件已保存至:{" "}
              <code className="bg-green-100 px-1 rounded">{outputPath}</code>
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>📄 总结预览</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleCopy}>
              <FileText className="mr-2 h-4 w-4" />
              复制内容
            </Button>
            {/* <Button variant="outline" size="sm">
              <Download className="mr-2 h-4 w-4" />
              下载文件
            </Button> */}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h4 className="font-medium mb-2 text-muted-foreground">
              📊 今日概览
            </h4>
            <p className="text-sm leading-relaxed">{summary.summary}</p>
          </div>

          <div>
            <h4 className="font-medium mb-2 text-muted-foreground">
              🎯 主要成就
            </h4>
            <ul className="list-disc list-inside text-sm space-y-1">
              {summary.achievements.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-medium mb-2 text-muted-foreground">
              💪 遇到的挑战
            </h4>
            <ul className="list-disc list-inside text-sm space-y-1">
              {summary.challenges.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-medium mb-2 text-muted-foreground">
              📅 明日计划
            </h4>
            <ul className="list-disc list-inside text-sm space-y-1">
              {summary.nextSteps.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
