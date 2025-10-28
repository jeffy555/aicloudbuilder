# AI-Driven DevOps Platform - Design Guidelines

## Design Approach

**Design System**: Hybrid approach combining Linear's modern developer tool aesthetic with GitHub's familiar DevOps patterns, optimized for conversational AI workflows and code-centric interfaces.

**Core Principle**: Create a professional, efficiency-focused interface that balances conversational AI guidance with technical precision for DevOps automation.

---

## Typography System

### Font Families
- **Primary Interface**: Inter (400, 500, 600) for UI elements, labels, and body text
- **Code/Technical**: JetBrains Mono (400, 500) for code blocks, file names, and repository paths
- **Conversational AI**: Inter (400, 500) for AI messages and user inputs

### Typography Hierarchy
- **Page Title**: text-2xl font-semibold (24px, 600 weight)
- **Section Headers**: text-lg font-medium (18px, 500 weight)
- **AI Messages**: text-base font-normal (16px, 400 weight)
- **Body Text**: text-sm font-normal (14px, 400 weight)
- **Labels/Meta**: text-xs font-medium (12px, 500 weight)
- **Code Inline**: text-sm font-mono (14px, 400 weight)

---

## Layout System

### Spacing Primitives
**Consistent Units**: 2, 4, 6, 8, 12, 16, 20, 24

**Application**:
- Component internal padding: p-4, p-6
- Section spacing: mb-8, mb-12, mt-16
- Tight groupings: gap-2, gap-4
- Breathing room: gap-6, gap-8
- Page margins: px-6, py-8

### Grid Structure
- **Main Container**: max-w-6xl mx-auto px-6
- **Two-Column Layout**: grid grid-cols-1 lg:grid-cols-12 gap-8
  - Conversation/Controls: lg:col-span-5
  - Code Preview: lg:col-span-7
- **Single Column Sections**: max-w-3xl mx-auto for focused workflows

---

## Component Library

### Navigation
**Top Bar**:
- Fixed header with app title "AI-Driven DevOps" (text-xl font-semibold)
- Subtle divider below (border-b)
- Height: h-16
- Layout: flex items-center justify-between px-6

### Conversational Interface

**AI Message Bubble**:
- Left-aligned with AI avatar icon (Heroicons: SparklesIcon w-5 h-5)
- Rounded container: rounded-2xl p-4
- Max width: max-w-2xl
- Spacing: mb-4
- Icon in circle: w-8 h-8 rounded-full flex items-center justify-center mb-2

**User Message Bubble**:
- Right-aligned
- Rounded container: rounded-2xl p-4
- Max width: max-w-lg ml-auto
- Spacing: mb-4

**Chat Input**:
- Sticky bottom bar or inline form
- Height: h-12
- Rounded: rounded-lg
- With send button: absolute right-2 top-2 (Heroicons: PaperAirplaneIcon)

### Repository Selection

**Provider Cards**:
- Two-column grid on desktop: grid grid-cols-2 gap-4
- Single column mobile: grid-cols-1
- Interactive cards with hover states
- Icon + title + description layout
- Padding: p-6
- Border radius: rounded-xl
- Icons: Heroicons (CodeBracketIcon for GitHub, CloudIcon for Azure DevOps) at w-8 h-8

**Repository List**:
- Clean list with radio buttons or checkboxes
- Each item: flex items-center gap-3 p-4 rounded-lg
- Repository name: font-medium
- Metadata (last updated, branch): text-xs opacity-60
- Dividers between items: divide-y

### Code Editor Interface

**File Tabs**:
- Horizontal tab list: flex gap-1 mb-4
- Individual tab: px-4 py-2 rounded-t-lg text-sm font-mono
- Active tab indicator with subtle emphasis

**Monaco Editor Container**:
- Border: border rounded-lg
- Minimum height: min-h-[400px]
- Full-width: w-full
- Syntax highlighting for HCL/Terraform
- Line numbers enabled

**File Preview Cards** (Alternative to tabs for multiple files):
- Stacked cards with file icon (Heroicons: DocumentTextIcon)
- Header: flex items-center justify-between p-3
- Filename: text-sm font-mono font-medium
- Expand/collapse toggle
- Content area: p-4 font-mono text-sm

### Action Buttons

**Primary CTA** (Approve & Commit):
- Large rounded button: rounded-lg px-6 py-3
- Text: text-base font-medium
- Full width on mobile: w-full sm:w-auto
- Icon prefix (Heroicons: CheckCircleIcon w-5 h-5)

**Secondary Actions** (Edit, Cancel):
- Medium rounded button: rounded-lg px-4 py-2
- Text: text-sm font-medium
- Outlined style with border

**Icon Buttons** (Refresh, Settings):
- Square: w-10 h-10
- Rounded: rounded-lg
- Center content: flex items-center justify-center
- Icon size: w-5 h-5

### Status & Feedback

**Step Indicators**:
- Horizontal stepper: flex items-center gap-2
- Step numbers in circles: w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold
- Connecting lines between steps
- Current step emphasized

**Success/Error Messages**:
- Rounded containers: rounded-lg p-4
- Icon on left (Heroicons: CheckCircleIcon or ExclamationTriangleIcon w-5 h-5)
- Message text: text-sm
- Layout: flex items-start gap-3

**Loading States**:
- Skeleton screens for repository lists
- Spinner for AI generation (Heroicons: ArrowPathIcon with animate-spin)
- Progress indicators for multi-step processes

### Forms

**Input Fields**:
- Height: h-10 or h-12
- Rounded: rounded-lg
- Padding: px-4
- Border: border
- Full width: w-full
- Label above: text-sm font-medium mb-2

**Textarea** (for custom prompts):
- Minimum height: min-h-[120px]
- Rounded: rounded-lg
- Padding: p-4
- Resize: resize-none or resize-y

---

## Layout Patterns

### Step 1: Provider Selection
- Centered layout: max-w-2xl mx-auto
- AI greeting message at top
- Two provider cards in grid below
- Vertical spacing: space-y-8

### Step 2: Repository Management
- Split layout on desktop
- Left: Repository list with search/filter
- Right: Create new repo form
- Mobile: Stacked single column

### Step 3: Terraform Generation
- Full-width conversation thread
- Sticky prompt input at bottom
- Generated files appear as the AI "speaks"

### Step 4: Review & Edit
- Two-column layout (lg breakpoint)
- Left column: File list/tabs with metadata
- Right column: Monaco editor full height
- Bottom: Action bar with Approve & Commit button

---

## Icons

**Library**: Heroicons (outline and solid variants via CDN)

**Key Icons**:
- AI Assistant: SparklesIcon
- GitHub: CodeBracketIcon or custom GitHub logo
- Azure DevOps: CloudIcon or custom Azure logo
- Repository: FolderIcon
- File: DocumentTextIcon
- Commit: ArrowUpTrayIcon
- Success: CheckCircleIcon
- Error: ExclamationTriangleIcon
- Settings: Cog6ToothIcon
- Refresh: ArrowPathIcon
- Send: PaperAirplaneIcon

**Icon Sizes**: w-4 h-4 (small), w-5 h-5 (default), w-6 h-6 (large), w-8 h-8 (extra large)

---

## Responsive Behavior

**Breakpoints**:
- Mobile: base (< 640px)
- Tablet: md (768px+)
- Desktop: lg (1024px+)

**Key Adaptations**:
- Navigation: Collapse to hamburger menu on mobile
- Repository list: Grid to single column on mobile
- Code editor: Full-width on mobile, 60% width on desktop
- Chat bubbles: Reduce max-width on mobile
- Action buttons: Full-width on mobile, auto-width on desktop

---

## Accessibility

- Focus states on all interactive elements (ring-2 ring-offset-2)
- ARIA labels for icon-only buttons
- Semantic HTML (nav, main, article for chat messages)
- Sufficient contrast ratios for all text
- Keyboard navigation support throughout
- Screen reader announcements for AI responses and status changes

---

## Animations

**Minimal & Purposeful**:
- Message appearance: Subtle fade-in (duration-200 ease-out)
- Button hover: Slight scale (hover:scale-105 transition-transform)
- Loading spinner: rotate animation (animate-spin)
- Page transitions: None (instant navigation for productivity)
- Code editor: No animations on typing/editing