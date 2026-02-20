import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronRight,
  Play,
  Pause,
  GitBranch,
  Shield,
  BarChart3,
  FileSearch,
  Download,
  Search,
  Folder,
  ArrowRight,
  SkipBack,
  SkipForward,
  Maximize2,
  Volume2,
  RefreshCw,
  Home,
} from "lucide-react";

interface Slide {
  step: number;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  content: React.ReactNode;
}

/* ─────────── Slide 1: Repository Selection ─────────── */
/* Mirrors: ScoreMe.tsx header + Card "Repository Details" + RepositoryList */
function SlideRepoSelection() {
  return (
    <div className="space-y-3">
      {/* Page header – matches real ScoreMe header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">ScoreMe</h2>
          <p className="text-[11px] text-slate-500">
            Run an AI-powered confidence report for your IaC and automation assets.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="px-2 py-1 rounded-md text-[10px] text-slate-500 bg-white border border-slate-200 flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> Refresh
          </span>
          <span className="px-2 py-1 rounded-md text-[10px] text-slate-500 bg-white border border-slate-200 flex items-center gap-1">
            <Home className="w-3 h-3" /> Home
          </span>
          <span className="px-2 py-1 rounded-md text-[10px] font-medium bg-slate-100 text-slate-600">GitHub</span>
          <span className="px-2 py-1 rounded-md text-[10px] font-medium bg-slate-100 text-slate-600">Azure DevOps</span>
        </div>
      </div>

      {/* Repository Details card – matches real Card with bg-primary/5 header */}
      <div className="rounded-xl border border-slate-200/60 shadow-lg bg-white overflow-hidden">
        <div className="bg-primary/5 border-b border-slate-200/50 px-4 py-3 flex items-center justify-between">
          <span className="font-semibold text-sm text-slate-800">Repository Details</span>
          <span className="text-xs text-slate-400">Score provider: GITHUB</span>
        </div>
        <div className="p-4 space-y-3">
          <label className="text-sm font-semibold text-slate-700">Repository</label>
          {/* RepositoryList mockup – matches real RadioGroup with FolderIcon */}
          <div className="border border-slate-200/50 rounded-2xl bg-slate-50/50 shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-white/70 border-b border-slate-100">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-xs text-slate-400">Search repositories...</span>
              <span className="ml-auto text-[10px] text-slate-400">3 of 3</span>
            </div>
            <div className="max-h-[140px] overflow-y-auto divide-y divide-slate-100">
              {/* Selected repo – radio style */}
              <label className="flex items-center gap-3 px-3 py-2.5 bg-primary/5 cursor-pointer">
                <div className="w-4 h-4 rounded-full border-2 border-primary flex items-center justify-center">
                  <div className="w-2 h-2 rounded-full bg-primary" />
                </div>
                <Folder className="w-4 h-4 text-slate-500" />
                <div className="flex-1">
                  <span className="text-xs font-medium text-slate-800">my-infra-repo</span>
                  <span className="block text-[10px] text-slate-400">main · Updated 2 days ago</span>
                </div>
              </label>
              <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50">
                <div className="w-4 h-4 rounded-full border-2 border-slate-300" />
                <Folder className="w-4 h-4 text-slate-400" />
                <div className="flex-1">
                  <span className="text-xs text-slate-600">terraform-modules</span>
                  <span className="block text-[10px] text-slate-400">main · Updated 5 days ago</span>
                </div>
              </label>
              <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50">
                <div className="w-4 h-4 rounded-full border-2 border-slate-300" />
                <Folder className="w-4 h-4 text-slate-400" />
                <div className="flex-1">
                  <span className="text-xs text-slate-600">k8s-manifests</span>
                  <span className="block text-[10px] text-slate-400">main · Updated 1 week ago</span>
                </div>
              </label>
            </div>
          </div>
          <div className="flex justify-end">
            <div className="px-4 py-2 rounded-md bg-primary text-white text-xs font-medium flex items-center gap-1.5">
              Run ScoreMe <ArrowRight className="w-3.5 h-3.5" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 2: Analyzing... ─────────── */
/* Mirrors: Real UI shows button as "Analyzing..." + disabled state while API call runs */
function SlideAnalysis() {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">ScoreMe</h2>
          <p className="text-[11px] text-slate-500">
            Run an AI-powered confidence report for your IaC and automation assets.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200/60 shadow-lg bg-white overflow-hidden">
        <div className="bg-primary/5 border-b border-slate-200/50 px-4 py-3 flex items-center justify-between">
          <span className="font-semibold text-sm text-slate-800">Repository Details</span>
          <span className="text-xs text-slate-400">Score provider: GITHUB</span>
        </div>
        <div className="p-4 space-y-3">
          <label className="text-sm font-semibold text-slate-700">Repository</label>
          <div className="border border-slate-200/50 rounded-2xl bg-slate-50/50 shadow-sm overflow-hidden">
            <label className="flex items-center gap-3 px-3 py-2.5 bg-primary/5">
              <div className="w-4 h-4 rounded-full border-2 border-primary flex items-center justify-center">
                <div className="w-2 h-2 rounded-full bg-primary" />
              </div>
              <Folder className="w-4 h-4 text-slate-500" />
              <span className="text-xs font-medium text-slate-800">my-infra-repo</span>
            </label>
          </div>
          <div className="flex justify-end">
            <div className="px-4 py-2 rounded-md bg-primary/60 text-white text-xs font-medium flex items-center gap-1.5 opacity-70 cursor-not-allowed">
              <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Analyzing...
            </div>
          </div>
        </div>
      </div>

      {/* Behind-the-scenes processing indicator */}
      <div className="rounded-xl border border-slate-200/60 shadow-lg bg-white p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-700">What's happening behind the scenes</p>
        <div className="space-y-2.5">
          {[
            { label: "Fetching repository file tree", done: true },
            { label: "Categorizing IaC assets (Terraform, K8s, Helm, Docker, Bicep, ARM)", done: true },
            { label: "Downloading and analyzing file contents", done: true },
            { label: "Running Checkov security scans", done: false },
            { label: "Calculating 4-pillar weighted score", done: false },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-2">
              {item.done ? (
                <div className="w-4 h-4 rounded-full bg-emerald-100 flex items-center justify-center">
                  <div className="w-2 h-2 rounded-full bg-emerald-500" />
                </div>
              ) : (
                <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              )}
              <span className={`text-xs ${item.done ? "text-slate-600" : "text-slate-500"}`}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 3: ScoreSheet Header + Pillar Scores ─────────── */
/* Mirrors: ScoreMe.tsx report section — rounded-3xl bg-white/80 shadow-2xl layout */
function SlideScoreSheet() {
  return (
    <div className="rounded-2xl bg-white/80 shadow-2xl border border-slate-200/60 p-4 space-y-4">
      {/* Header: ScoreSheet title + confidence + final score */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">ScoreSheet</h2>
          <p className="text-[11px] text-slate-500">
            Provider: GITHUB · Repository: my-infra-repo
          </p>
          <p className="mt-1 text-sm font-semibold text-blue-600">
            Confidence: Needs minor fixes
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-center">
            <p className="text-[9px] uppercase tracking-widest text-slate-400">Final score</p>
            <p className="text-3xl font-bold text-primary">74.0%</p>
          </div>
          <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 bg-white text-[11px] font-medium text-slate-700">
            <Download className="w-3 h-3" />
            Download ScoreSheet
          </div>
        </div>
      </div>
      <div className="text-[10px] text-slate-400">Updated {new Date().toLocaleString()}</div>

      {/* Pillar Scores grid – exact real layout: md:grid-cols-4, rounded-2xl bg-slate-50 */}
      <div>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">Pillar Scores</h3>
        <div className="grid grid-cols-4 gap-2">
          {[
            { name: "Security & Compliance", score: 80, weight: 40, details: ["Checkov 12/15 passed", "No critical findings"] },
            { name: "Infra Coverage", score: 65, weight: 25, details: ["Terraform detected", "No Bicep/ARM found"] },
            { name: "Automated Scanning", score: 80, weight: 20, details: ["CI pipeline present", "Linting configured"] },
            { name: "Container & Automation", score: 65, weight: 15, details: ["Dockerfile found", "No Helm charts"] },
          ].map((pillar) => (
            <div key={pillar.name} className="rounded-xl border border-slate-200/40 bg-slate-50 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-semibold text-slate-600 leading-tight">{pillar.name}</span>
                <span className="text-[11px] font-bold text-slate-800">{pillar.score}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-600 to-green-500"
                  style={{ width: `${pillar.score}%` }}
                />
              </div>
              <div className="text-[8px] uppercase tracking-[0.3em] text-slate-400">Weight {pillar.weight}%</div>
              <div className="text-[9px] text-slate-500 space-y-0.5">
                {pillar.details.map((d) => (
                  <p key={d}>• {d}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 4: Inventory ─────────── */
/* Mirrors: ScoreMe.tsx Inventory section — grid with type/path/summary columns */
function SlideInventory() {
  return (
    <div className="rounded-2xl bg-white/80 shadow-2xl border border-slate-200/60 p-4 space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">ScoreSheet</h2>
          <p className="text-[11px] text-slate-500">Provider: GITHUB · Repository: my-infra-repo</p>
        </div>
        <div className="text-center">
          <p className="text-[9px] uppercase tracking-widest text-slate-400">Final score</p>
          <p className="text-2xl font-bold text-primary">74.0%</p>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">Inventory</h3>
        <div className="space-y-1.5">
          {[
            { type: "Terraform", path: "infra/", summary: "3 .tf files with azurerm provider", files: ["main.tf", "variables.tf", "outputs.tf"] },
            { type: "Kubernetes", path: "k8s/", summary: "2 manifests (deployment + service)", files: ["deployment.yaml", "service.yaml"] },
            { type: "Dockerfile", path: ".", summary: "1 multi-stage Dockerfile", files: ["Dockerfile"] },
            { type: "Automation", path: "scripts/", summary: "2 shell scripts for CI/CD", files: ["deploy.sh", "build.sh"] },
          ].map((entry) => (
            <div key={entry.path} className="grid grid-cols-[100px_1fr_140px] gap-3 rounded-lg border border-slate-200/30 bg-white p-2.5">
              <span className="font-semibold uppercase tracking-[0.3em] text-[9px] text-slate-400">{entry.type}</span>
              <div>
                <p className="text-[11px] font-medium text-slate-900">{entry.path}</p>
                <p className="text-[10px] text-slate-500">{entry.summary}</p>
                <div className="mt-1">
                  <p className="text-[9px] font-semibold text-slate-600">Files scanned</p>
                  <ul className="list-disc list-inside text-[9px] text-slate-500">
                    {entry.files.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <span className="text-[10px] text-slate-400 hidden md:block">{entry.summary}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────── Slide 5: Findings & Remediation + Download ─────────── */
/* Mirrors: ScoreMe.tsx Findings section — rounded-2xl cards with severity badges */
function SlideFindingsReport() {
  return (
    <div className="rounded-2xl bg-white/80 shadow-2xl border border-slate-200/60 p-4 space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">ScoreSheet</h2>
          <p className="text-[11px] text-slate-500">Provider: GITHUB · Repository: my-infra-repo</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 bg-white text-[11px] font-medium text-slate-700">
            <Download className="w-3 h-3" />
            Download ScoreSheet
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">Findings & Remediation</h3>
        <div className="space-y-2">
          {[
            {
              category: "Terraform",
              severity: "high",
              sevClass: "bg-orange-100 text-orange-600",
              message: "Storage account missing access logging",
              file: "infra/main.tf",
              remediation: "Add a logging block to azurerm_storage_account",
            },
            {
              category: "Terraform",
              severity: "medium",
              sevClass: "bg-amber-100 text-amber-700",
              message: "Storage account allows public blob access",
              file: "infra/main.tf",
              remediation: "Set allow_nested_items_to_be_public = false",
            },
            {
              category: "Kubernetes",
              severity: "medium",
              sevClass: "bg-amber-100 text-amber-700",
              message: "Container image using latest tag",
              file: "k8s/deployment.yaml",
              remediation: "Use a fixed version tag (e.g. v1.2.3)",
            },
            {
              category: "Automation",
              severity: "low",
              sevClass: "bg-slate-100 text-slate-500",
              message: "Script missing error handling",
              file: "scripts/deploy.sh",
              remediation: "Add set -euo pipefail at the top",
            },
          ].map((finding, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-200/40 bg-white p-3 space-y-1 shadow-sm"
            >
              <div className="flex items-center justify-between text-[11px] font-semibold">
                <span className="text-slate-700">{finding.category}</span>
                <span className={`px-1.5 py-0.5 text-[9px] font-semibold rounded-full ${finding.sevClass}`}>
                  {finding.severity}
                </span>
              </div>
              <p className="text-[11px] text-slate-800">{finding.message}</p>
              <p className="text-[9px] text-slate-400">File: {finding.file}</p>
              <p className="text-[11px] font-semibold text-slate-900">Remediation</p>
              <p className="text-[10px] text-slate-500">{finding.remediation}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const slides: Slide[] = [
  {
    step: 1,
    title: "Select Repository",
    subtitle: "Choose your provider and pick the repository to analyze",
    icon: GitBranch,
    content: <SlideRepoSelection />,
  },
  {
    step: 2,
    title: "Automated Analysis",
    subtitle: "ScoreMe fetches files, categorizes assets, and runs Checkov scans",
    icon: FileSearch,
    content: <SlideAnalysis />,
  },
  {
    step: 3,
    title: "Confidence Score",
    subtitle: "Weighted score across 4 pillars with confidence rating",
    icon: BarChart3,
    content: <SlideScoreSheet />,
  },
  {
    step: 4,
    title: "Asset Inventory",
    subtitle: "All detected IaC resources categorized by type with scanned files",
    icon: Shield,
    content: <SlideInventory />,
  },
  {
    step: 5,
    title: "Findings & Download",
    subtitle: "Findings with remediation guidance and downloadable HTML report",
    icon: Download,
    content: <SlideFindingsReport />,
  },
];

const SLIDE_DURATION = 5000;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ScoreMeWalkthrough() {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const progressRef = useRef<number>(0);
  const animFrameRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);

  const totalDuration = slides.length * SLIDE_DURATION;
  const elapsedSeconds = (progress / 100) * (totalDuration / 1000);
  const totalSeconds = totalDuration / 1000;

  const nextSlide = useCallback(() => {
    setCurrentSlide((prev) => {
      const next = (prev + 1) % slides.length;
      progressRef.current = (next / slides.length) * 100;
      setProgress(progressRef.current);
      return next;
    });
  }, []);

  const prevSlide = useCallback(() => {
    setCurrentSlide((prev) => {
      const next = (prev - 1 + slides.length) % slides.length;
      progressRef.current = (next / slides.length) * 100;
      setProgress(progressRef.current);
      return next;
    });
  }, []);

  // Smooth progress animation
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(animFrameRef.current);
      return;
    }

    lastTickRef.current = performance.now();

    const animate = (now: number) => {
      const delta = now - lastTickRef.current;
      lastTickRef.current = now;

      const increment = (delta / totalDuration) * 100;
      progressRef.current += increment;

      if (progressRef.current >= 100) {
        progressRef.current = 0;
        setCurrentSlide(0);
      } else {
        const newSlide = Math.min(slides.length - 1, Math.floor((progressRef.current / 100) * slides.length));
        setCurrentSlide((prev) => (newSlide !== prev ? newSlide : prev));
      }

      setProgress(progressRef.current);
      animFrameRef.current = requestAnimationFrame(animate);
    };

    animFrameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isPlaying, totalDuration]);

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    progressRef.current = pct;
    setProgress(pct);
    const newSlide = Math.min(slides.length - 1, Math.floor((pct / 100) * slides.length));
    setCurrentSlide(newSlide);
  };

  if (!slides || slides.length === 0) return null;
  const safeIndex = Math.min(currentSlide, slides.length - 1);
  const slide = slides[safeIndex];
  if (!slide) return null;
  const Icon = slide.icon;

  return (
    <div className="rounded-xl overflow-hidden shadow-2xl border border-slate-800 bg-slate-950">
      {/* Slide header bar */}
      <div className="bg-slate-900 px-5 py-3 flex items-center gap-3 border-b border-slate-800">
        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-semibold text-white">
            Step {slide.step} of {slides.length}: {slide.title}
          </p>
          <p className="text-[11px] text-slate-400">{slide.subtitle}</p>
        </div>
        <div className="flex gap-1">
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => {
                setCurrentSlide(i);
                progressRef.current = (i / slides.length) * 100;
                setProgress(progressRef.current);
              }}
              className={`w-2 h-2 rounded-full transition-all ${
                i === currentSlide ? "bg-primary scale-125" : i < currentSlide ? "bg-primary/40" : "bg-slate-600"
              }`}
              title={`Step ${s.step}: ${s.title}`}
            />
          ))}
        </div>
      </div>

      {/* Slide content area */}
      <div className="p-5 bg-gradient-to-b from-slate-100 to-slate-50 min-h-[340px] relative">
        {/* Play overlay when paused */}
        {!isPlaying && (
          <button
            onClick={() => setIsPlaying(true)}
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/5 hover:bg-black/10 transition-colors cursor-pointer"
          >
            <div className="w-16 h-16 rounded-full bg-black/70 backdrop-blur-sm flex items-center justify-center shadow-xl hover:bg-black/80 transition-colors">
              <Play className="w-7 h-7 text-white ml-1" />
            </div>
          </button>
        )}
        {slide.content}
      </div>

      {/* Video control bar */}
      <div className="bg-gradient-to-t from-slate-950 to-slate-900 px-2 pt-0 pb-2">
        {/* Progress bar */}
        <div
          className="group h-5 flex items-center cursor-pointer px-2"
          onClick={handleProgressClick}
        >
          <div className="w-full h-1 group-hover:h-1.5 bg-slate-700 rounded-full relative transition-all">
            {/* Segment markers */}
            {slides.map((_, i) => {
              const pos = ((i + 1) / slides.length) * 100;
              if (i === slides.length - 1) return null;
              return (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 w-px bg-slate-600"
                  style={{ left: `${pos}%` }}
                />
              );
            })}
            {/* Progress fill */}
            <div
              className="absolute top-0 left-0 h-full bg-red-600 rounded-full transition-none"
              style={{ width: `${progress}%` }}
            />
            {/* Scrubber dot */}
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity shadow-md"
              style={{ left: `${progress}%`, marginLeft: "-6px" }}
            />
          </div>
        </div>

        {/* Control buttons row */}
        <div className="flex items-center gap-1 px-1">
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="p-1.5 text-white hover:text-white/80 transition-colors"
          >
            {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>

          <button
            onClick={() => { prevSlide(); setIsPlaying(false); }}
            className="p-1.5 text-white/70 hover:text-white transition-colors"
          >
            <SkipBack className="w-4 h-4" />
          </button>

          <button
            onClick={() => { nextSlide(); setIsPlaying(false); }}
            className="p-1.5 text-white/70 hover:text-white transition-colors"
          >
            <SkipForward className="w-4 h-4" />
          </button>

          <button className="p-1.5 text-white/70 hover:text-white transition-colors">
            <Volume2 className="w-4 h-4" />
          </button>

          <span className="text-[11px] text-slate-400 font-mono ml-1">
            {formatTime(elapsedSeconds)} / {formatTime(totalSeconds)}
          </span>

          <div className="flex-1" />

          <span className="text-[10px] text-slate-500 mr-2">
            ScoreMe Walkthrough
          </span>

          <button className="p-1.5 text-white/70 hover:text-white transition-colors">
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
