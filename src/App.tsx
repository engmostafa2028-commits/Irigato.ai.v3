/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { 
  Cloud,
  Thermometer,
  CloudRain,
  Sun,
  Droplet, 
  Send, 
  Loader2, 
  MessageSquare, 
  ChevronLeft, 
  ChevronRight,
  TrendingUp,
  Waves,
  Sprout,
  Activity,
  History,
  LayoutDashboard,
  Menu,
  X,
  Maximize,
  Minimize,
  Download,
  Save,
  FolderOpen,
  Trash2,
  Plus,
  Scale,
  Wind,
  RefreshCcw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from "@google/genai";
import * as d3 from 'd3';
import jsPDF from 'jspdf';
import { toPng } from 'html-to-image';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  addDoc, 
  query, 
  where, 
  getDocs, 
  serverTimestamp, 
  orderBy,
  deleteDoc,
  doc
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  AreaChart, 
  Area,
  ReferenceLine,
  ReferenceArea,
  Label,
  BarChart,
  Bar,
  Cell,
  Legend,
  PieChart,
  Pie
} from 'recharts';

// --- Types ---
interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp?: number;
}

interface AnalysisResult {
  summary: string;
  charts: {
    seasonalWaterDemand: Array<{ month: string; amount: number }>;
    waterBalance: {
      netRequirement: number;
      efficiencyLoss: number;
      deepPercolation: number;
      rainfallEffective: number;
      totalGross: number;
    };
    soilHydrology: {
      fieldCapacity: number;
      permanentWiltingPoint: number;
      temporaryWiltingPoint: number;
      currentLevel: number;
    };
    schedulingLog: Array<{ day: number; moisture: number; irrigation: number }>;
    rootZone: {
      activeDepth: number;
      totalDepth: number;
      cropName: string;
    };
    weatherForecast: Array<{ 
      day: string; 
      temp: number; 
      precipitationProb: number;
      condition: 'sun' | 'cloud' | 'rain';
      windSpeed: number;
      windEffect: string;
    }>;
  };
  design: {
    length: number;
    width: number;
    mainLine: string;
    subMainLine: string;
    laterals: string;
    sprinklerRadius: number;
    sprinklerSpacing: number;
    sprinklerEfficiency: number;
    pump: { x: number; y: number; pressureBar: number; capacity: number; type?: string };
    valves: Array<{ id: string; x: number; y: number }>;
    zones: Array<{ id: string; x: number; y: number; width: number; height: number; color: string }>;
  };
  monthlyRecommendations: Array<{
    month: string;
    frequency: string;
    duration: string;
    tip: string;
  }>;
}

const ai = new GoogleGenAI({ apiKey: process.env.VITE_GEMINI_API_KEY });

// --- Firebase Initialization ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

const LOCAL_STORAGE_KEY = 'irrigato_current_session';

export default function App() {
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.messages) return parsed.messages;
      } catch (e) {}
    }
    return [{ role: 'model', text: 'مرحباً بك مهندسنا. أنا مساعدك الذكي لتصميم شبكات الري. يرجى تزويدي بتفاصيل الأرض: المساحة، الكروكي (الأبعاد)، نوع المحصول، المنطقة، حالة الطقس، ونوع التربة.', timestamp: Date.now() }];
  });
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.analysis) return parsed.analysis;
      } catch (e) {}
    }
    return null;
  });
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [savedDesigns, setSavedDesigns] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [designName, setDesignName] = useState(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.designName) return parsed.designName;
      } catch(e) {}
    }
    return '';
  });
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [compareSelection, setCompareSelection] = useState<any[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const dashboardRef = useRef<HTMLDivElement>(null);
  
  // Custom Export Additions
  const summaryRef = useRef<HTMLDivElement>(null);
  const demandRef = useRef<HTMLDivElement>(null);
  const weatherRef = useRef<HTMLDivElement>(null);
  const lossesRef = useRef<HTMLDivElement>(null);
  const schedulingRef = useRef<HTMLDivElement>(null);
  const rootZoneRef = useRef<HTMLDivElement>(null);
  const networkOptionsRef = useRef<HTMLDivElement>(null);
  const blueprintRef = useRef<HTMLDivElement>(null);

  const EXPORT_SECTIONS = [
    { id: 'summary', name: 'الميزانية المائية والاحتياج', ref: summaryRef },
    { id: 'demand', name: 'الاحتياج الشهري للمحصول ETc', ref: demandRef },
    { id: 'weather', name: 'حالة الطقس وسرعة الرياح', ref: weatherRef },
    { id: 'losses', name: 'تحليل الفواقد التبخرية والتسرب', ref: lossesRef },
    { id: 'scheduling', name: 'المرصد وجدولة رطوبة التربة', ref: schedulingRef },
    { id: 'rootZone', name: 'مؤشرات نمو وحالة الجذور', ref: rootZoneRef },
    { id: 'networkOptions', name: 'مواصفات الشبكة وكفاءة الرشاشات', ref: networkOptionsRef },
    { id: 'blueprint', name: 'المخطط الهندسي الحي لشبكة الري', ref: blueprintRef },
  ];

  const [showExportModal, setShowExportModal] = useState(false);
  const [exportSelection, setExportSelection] = useState<string[]>(EXPORT_SECTIONS.map(s => s.id));

  const [overrides, setOverrides] = useState<{
    mainLine?: string;
    subMainLine?: string;
    laterals?: string;
    rootDepth?: number;
    sprinklerEfficiency?: number;
  }>(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.overrides) return parsed.overrides;
      } catch (e) {}
    }
    return {};
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
      messages,
      analysis,
      designName,
      overrides
    }));
  }, [messages, analysis, designName, overrides]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Firebase Auth & Initial Load
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setCurrentUser(user);
        loadSavedDesigns(user.uid);
      } else {
        setCurrentUser(null);
        setSavedDesigns([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleNewSession = () => {
    if (messages.length > 1 || analysis) {
      if (!confirm('هل أنت متأكد من رغبتك في بدء تصميم جديد؟ سيتم مسح السجل الحالي غير المحفوظ.')) return;
    }
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    setMessages([{ role: 'model', text: 'مرحباً بك مهندسنا. أنا مساعدك الذكي لتصميم شبكات الري. يرجى تزويدي بتفاصيل الأرض: المساحة، الكروكي (الأبعاد)، نوع المحصول، المنطقة، حالة الطقس، ونوع التربة.', timestamp: Date.now() }]);
    setAnalysis(null);
    setDesignName('');
    setOverrides({});
  };

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login Error:", error);
      alert("حدث خطأ أثناء تسجيل الدخول بـ Google.");
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setDesignName('');
      setAnalysis(null);
      setOverrides({});
    } catch (error) {
      console.error("Logout Error:", error);
    }
  };

  const loadSavedDesigns = async (uid: string) => {
    setIsLoadingList(true);
    try {
      const q = query(
        collection(db, "designs"), 
        where("userId", "==", uid),
        orderBy("updatedAt", "desc")
      );
      const querySnapshot = await getDocs(q);
      const designs = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setSavedDesigns(designs);
    } catch (error) {
      console.error("Error loading designs:", error);
    } finally {
      setIsLoadingList(false);
    }
  };

  const handleSaveDesign = async () => {
    if (!analysis) return;
    if (!currentUser) {
      alert("عذراً، يجب تسجيل الدخول أولاً لحفظ التصميم في قاعدة البيانات.");
      handleLogin();
      return;
    }
    const name = prompt("أدخل اسماً لهذا التصميم:", designName || `تصميم ري - ${new Date().toLocaleDateString('ar-EG')}`);
    if (!name) return;

    setIsSaving(true);
    try {
      await addDoc(collection(db, "designs"), {
        name,
        userId: currentUser.uid,
        analysis,
        overrides,
        messages,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      setDesignName(name);
      loadSavedDesigns(currentUser.uid);
      alert("تم حفظ التصميم بنجاح!");
    } catch (error) {
      console.error("Error saving design:", error);
      alert("حدث خطأ أثناء حفظ التصميم.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportPDF = async (exportAll: boolean = false) => {
    if (!analysis) return;
    setIsExporting(true);
    try {
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const marginX = 10;
      const usableWidth = pageWidth - 2 * marginX;
      let currentY = 15;

      const targetIds = exportAll ? EXPORT_SECTIONS.map(s => s.id) : exportSelection;
      if (targetIds.length === 0) {
        setIsExporting(false);
        return;
      }

      for (let i = 0; i < targetIds.length; i++) {
        const section = EXPORT_SECTIONS.find(s => s.id === targetIds[i]);
        if (!section || !section.ref.current) continue;

        const imgData = await toPng(section.ref.current, {
          pixelRatio: 2,
          backgroundColor: '#ffffff',
          style: {
            transform: 'scale(1)',
          }
        });

        const imgProps = pdf.getImageProperties(imgData);
        const imgHeight = (imgProps.height * usableWidth) / imgProps.width;

        if (currentY + imgHeight > 280 && i > 0) {
          pdf.addPage();
          currentY = 15;
        }

        // Add title for section in standard jsPDF font (English to avoid Arabic font issues, or just skip text and rely on images. We'll skip text here to avoid Arabic font corruption and just use the image which has the Arabic UI).
        pdf.addImage(imgData, 'PNG', marginX, currentY, usableWidth, imgHeight);
        currentY += imgHeight + 10;
      }

      pdf.save(`irrigato-design-${designName || new Date().getTime()}.pdf`);
      setShowExportModal(false);
    } catch (error) {
      console.error("PDF Export Error:", error);
      alert("حدث خطأ أثناء تصدير ملف PDF.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleLoadDesign = (design: any) => {
    setAnalysis(design.analysis);
    setOverrides(design.overrides || {});
    setDesignName(design.name);
    if (design.messages && design.messages.length > 0) {
      setMessages(design.messages);
    } else {
      setMessages(prev => [...prev, { role: 'model', text: `تم تحميل التصميم: ${design.name}`, timestamp: Date.now() }]);
    }
    setShowLoadModal(false);
  };

  const handleDeleteDesign = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("هل أنت متأكد من رغبتك في حذف هذا التصميم؟")) return;
    try {
      await deleteDoc(doc(db, "designs", id));
      loadSavedDesigns(currentUser?.uid || '');
    } catch (error) {
      console.error("Error deleting design:", error);
    }
  };

  const handleSend = async (messageText?: string) => {
    const textToSend = messageText || inputText.trim();
    if (!textToSend) return;
    
    const userMsg = textToSend;
    setMessages(prev => [...prev, { role: 'user', text: userMsg, timestamp: Date.now() }]);
    setInputText('');
    setIsTyping(true);

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          ...messages.map(m => ({ role: m.role, parts: [{ text: m.text }] })),
          { 
            role: 'user', 
            parts: [{ 
              text: `[سياق النظام: المستخدم قام بتعديل بعض القيم يدوياً: ${JSON.stringify(overrides)}]. الطلب الحالي: ${userMsg}` 
            }] 
          }
        ],
        config: {
          systemInstruction: `أنت خبير هندسة ري زراعية محترف. تواصل باللغة العربية بلهجة مهنية.
            مهمتك الأساسية هي تحليل بيانات الأرض وتصميم شبكة ري كاملة بصيغة JSON.
            
            مصادر البيانات الأساسية (هام جداً):
            - يجب أن تعتمد في كافة حسابات احتياجات المحاصيل المائية (Crop Water Requirements) ومعاملات المحاصيل (Kc) وعمق الجذور وطرق حساب البخر نتح (ETo) حصرياً على مرجعيات ومنهجيات منظمة الأغذية والزراعة (الفاو - FAO)، وتحديداً نشرة الفاو رقم 56 (FAO-56 Penman-Monteith).
            - في حال توفير المستخدم للمنطقة الجغرافية، يجب أن تستند في حساباتك وتوقعاتك المناخية (درجات الحرارة، الرطوبة، سرعة الرياح، الإشعاع الشمسي، ومعدلات هطول الأمطار) إلى السجلات والبيانات المرجعية من هيئة الأرصاد الجوية العالمية والإقليمية.
            - اذكر دائماً في تعليقاتك وملخصاتك أن التقديرات مبنية على منهجية الفاو (FAO) وبيانات هيئة الأرصاد.
            
            قواعد صارمة:
            1. يجب أن يحتوي كل رد منك على كائن "data" كاملاً يحتوي على تقديرات هندسية أولية حتى لو كانت المعلومات المقدمة من المستخدم ناقصة.
            2. استخدم خبرتك لتقدير القيم (مثل السعة الحقلية بناءً على نوع التربة، أو الاحتياج المائي بناءً على المنطقة والمحصول) في حال لم يذكرها المستخدم.
            3. لا ترسل "chatResponse" وحيداً أبداً؛ يجب أن يصاحبه دائماً تحديث للوحة التحكم في كائن "data". حتى لو كان المستخدم يسأل سؤالاً بسيطاً أو يشكرك، أعد إرسال بيانات لوحة التحكم الحالية بالتفصيل.
            4. "isAnalysisReady": اجعلها true بمجرد أن يكون لديك تصور عن أبعاد الأرض والمحصول، حتى لو كان التقدير أولياً.
            5. موازنة المياه (waterBalance): احسب الاحتياج الصافي (netRequirement)، ثم أضف فواقد الكفاءة (efficiencyLoss) والتسرب العميق (deepPercolation)، واخصم الأمطار المؤثرة (rainfallEffective) للوصول إلى الإجمالي الكلي (totalGross).
            6. كفاءة الري (sprinklerEfficiency): احترم قيمة الكفاءة المدخلة من المستخدم في كائن overrides (إن وجدت). تعامل معها كنسبة مئوية (مثلاً 75%) واستخدمها لحساب فواقد الكفاءة (efficiencyLoss).
            7. توقعات الطقس (weatherForecast): قدم توقعات لـ 3 أيام لمساعدة المستخدم في اتخاذ قرارات ري استباقية. تأكد أن التوقعات تؤثر على جدول الري المقترح (schedulingLog).
            8. التوصيات الشهرية (monthlyRecommendations): قدم نصائح محددة لكل شهر تشمل (التكرار، المدة، ونصيحة تقنية) بناءً على المناخ والمحصول.
            9. تصميم الشبكة المتقدم (مهم جداً للرسم): 
               - إذا كانت المساحة صغيرة (مثلاً أقل من 500 متر مربع)، قد لا تحتاج لتقسيم (zones) أو خطوط فرعية (subMainLine)، ويكفي خط رئيسي ومضخة.
               - إذا كانت المساحة كبيرة، قم بتقسيم الأرض إلى "قطاعات" (zones) لتوزيع الضغط، وضع "محبس" (valve) لكل قطاع.
               - حدد مكان المضخة (pump) وإحداثياتها بدقة، وتوقع الضغط التشغيلي (pressureBar) المطلوب للحفاظ على انتظام الري، وحدد نوع المضخة الموصى به (type) (مثل "مضخة غاطسة"، "مضخة طاردة مركزية"، إلخ).
            
            مكونات "data" المطلوبة دائماً:
            - "summary": ملخص للحالة الحالية أو التعديلات.
            - "seasonalWaterDemand": توقع الاستهلاك لـ 12 شهر.
            - "waterBalance": الموازنة المائية التفصيلية للموسم.
            - "monthlyRecommendations": توصيات الري التفصيلية لكل شهر.
            - "weatherForecast": توقعات الطقس لـ 3 أيام.
            - "soilHydrology": قيم تقنية دقيقة للتربة.
            - "schedulingLog": سجل يومي لـ 30 يوماً (نمط المنشار).
            - "design": يحتوي على أبعاد الأرض، أقطار المواسير، المسافات، وتقسيم القطاعات والمحابس والمضخة.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              chatResponse: { type: Type.STRING },
              isAnalysisReady: { type: Type.BOOLEAN },
              data: {
                type: Type.OBJECT,
                properties: {
                  summary: { type: Type.STRING },
                  charts: {
                    type: Type.OBJECT,
                    properties: {
                      seasonalWaterDemand: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            month: { type: Type.STRING },
                            amount: { type: Type.NUMBER }
                          },
                          required: ["month", "amount"]
                        }
                      },
                      waterBalance: {
                        type: Type.OBJECT,
                        properties: {
                          netRequirement: { type: Type.NUMBER },
                          efficiencyLoss: { type: Type.NUMBER },
                          deepPercolation: { type: Type.NUMBER },
                          rainfallEffective: { type: Type.NUMBER },
                          totalGross: { type: Type.NUMBER }
                        },
                        required: ["netRequirement", "efficiencyLoss", "deepPercolation", "rainfallEffective", "totalGross"]
                      },
                      soilHydrology: {
                        type: Type.OBJECT,
                        properties: {
                          fieldCapacity: { type: Type.NUMBER },
                          permanentWiltingPoint: { type: Type.NUMBER },
                          temporaryWiltingPoint: { type: Type.NUMBER },
                          currentLevel: { type: Type.NUMBER }
                        },
                        required: ["fieldCapacity", "permanentWiltingPoint", "temporaryWiltingPoint", "currentLevel"]
                      },
                      schedulingLog: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            day: { type: Type.NUMBER },
                            moisture: { type: Type.NUMBER },
                            irrigation: { type: Type.NUMBER }
                          },
                          required: ["day", "moisture", "irrigation"]
                        }
                      },
                      rootZone: {
                        type: Type.OBJECT,
                        properties: {
                          activeDepth: { type: Type.NUMBER },
                          totalDepth: { type: Type.NUMBER },
                          cropName: { type: Type.STRING }
                        },
                        required: ["activeDepth", "totalDepth", "cropName"]
                      },
                      weatherForecast: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            day: { type: Type.STRING },
                            temp: { type: Type.NUMBER },
                            precipitationProb: { type: Type.NUMBER },
                            condition: { type: Type.STRING, enum: ['sun', 'cloud', 'rain'] },
                            windSpeed: { type: Type.NUMBER, description: "سرعة الرياح المتوقعة كم/ساعة" },
                            windEffect: { type: Type.STRING, description: "وصف انبعاج قطر الرشاشة بناء على سرعة الرياح" }
                          },
                          required: ["day", "temp", "precipitationProb", "condition", "windSpeed", "windEffect"]
                        }
                      }
                    },
                    required: ["seasonalWaterDemand", "waterBalance", "soilHydrology", "schedulingLog", "rootZone", "weatherForecast"]
                  },
                  design: {
                    type: Type.OBJECT,
                    properties: {
                      length: { type: Type.NUMBER },
                      width: { type: Type.NUMBER },
                      mainLine: { type: Type.STRING },
                      subMainLine: { type: Type.STRING },
                      laterals: { type: Type.STRING },
                      sprinklerRadius: { type: Type.NUMBER },
                      sprinklerSpacing: { type: Type.NUMBER },
                      sprinklerEfficiency: { type: Type.NUMBER },
                      pump: {
                        type: Type.OBJECT,
                        properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, pressureBar: { type: Type.NUMBER }, capacity: { type: Type.NUMBER }, type: { type: Type.STRING } },
                        required: ["x", "y", "pressureBar", "capacity"]
                      },
                      valves: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
                          required: ["id", "x", "y"]
                        }
                      },
                      zones: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: { id: { type: Type.STRING }, x: { type: Type.NUMBER }, y: { type: Type.NUMBER }, width: { type: Type.NUMBER }, height: { type: Type.NUMBER }, color: { type: Type.STRING } },
                          required: ["id", "x", "y", "width", "height", "color"]
                        }
                      }
                    },
                    required: ["length", "width", "mainLine", "subMainLine", "laterals", "sprinklerRadius", "sprinklerSpacing", "sprinklerEfficiency", "pump", "valves", "zones"]
                  },
                  monthlyRecommendations: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        month: { type: Type.STRING },
                        frequency: { type: Type.STRING },
                        duration: { type: Type.STRING },
                        tip: { type: Type.STRING }
                      },
                      required: ["month", "frequency", "duration", "tip"]
                    }
                  }
                },
                required: ["summary", "charts", "design", "monthlyRecommendations"]
              }
            },
            required: ["chatResponse", "isAnalysisReady", "data"]
          }
        }
      });

      const result = JSON.parse(response.text);
      setMessages(prev => [...prev, { role: 'model', text: result.chatResponse, timestamp: Date.now() }]);
      
      if (result.data) {
        setAnalysis(result.data);
      }
    } catch (err: any) {
      console.error(err);
      let errorMsg = 'عذراً، حدث خطأ في معالجة البيانات. يرجى المحاولة مرة أخرى.';
      
      if (err?.message?.includes('429') || err?.status === 429 || err?.message?.toLowerCase().includes('quota') || err?.code === 'RESOURCE_EXHAUSTED') {
        errorMsg = 'عذراً، تم الوصول للحد الأقصى للاستخدام اليومي للذكاء الاصطناعي (Quota Exceeded). هذا الحد يتم تصفيره تلقائياً كل فترة. يرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى.';
      }
      
      setMessages(prev => [...prev, { role: 'model', text: errorMsg, timestamp: Date.now() }]);
    } finally {
      setIsTyping(false);
    }
  };

  const getSuggestions = () => {
    if (analysis) {
        return [
            "تغيير النظام إلى ري بالتنقيط",
            "قم بتعديل كفاءة الري إلى 85%",
            "هل يمكنك تقديم معلومات عن المضخة؟"
        ];
    } else {
        return [
            "أرض 10 فدان، محصول قمح، تربة طينية",
            "مساحة 500 متر مربع مزروعة بالخضروات",
            "تصميم شبكة بالتنقيط لـ 2 فدان طماطم"
        ];
    }
  };

  const designValues = useMemo(() => {
    if (!analysis) return null;
    return {
      ...analysis.design,
      mainLine: overrides.mainLine || analysis.design.mainLine,
      subMainLine: overrides.subMainLine || analysis.design.subMainLine,
      laterals: overrides.laterals || analysis.design.laterals,
    };
  }, [analysis, overrides]);

  const { points: sprinklers, isDrip, visualLateralCount, visualLateralSpacing } = useMemo(() => {
    if (!designValues) return { points: [], isDrip: false, visualLateralCount: 0, visualLateralSpacing: 0 };
    const points = [];
    const { length, width, sprinklerSpacing, sprinklerRadius } = designValues;
    
    // If spacing is invalid or not defined, return empty
    if (!sprinklerSpacing || sprinklerSpacing <= 0) {
      return { points: [], isDrip: false, visualLateralCount: 0, visualLateralSpacing: 0 };
    }
    
    // Determine if it's a drip system (very small radius or spacing)
    const isDrip = sprinklerRadius <= 1.5 || sprinklerSpacing <= 0.5;

    // Dynamically calculate lateral lines: avoid drawing 1000s of laterals which ruin UI
    const exactNumLaterals = Math.floor(width / sprinklerSpacing) + 1;
    const visualLateralCount = Math.min(exactNumLaterals, 80); // Cap at 80 laterals max visually
    const visualLateralSpacing = width / Math.max(1, (visualLateralCount - 1));

    let visualSpacingX = Math.max(0.1, sprinklerSpacing);
    
    // Limit maximum visual dots along the X-axis for performance
    const dotsPerLateral = length / visualSpacingX;
    const totalDots = dotsPerLateral * visualLateralCount;
    const maxDots = isDrip ? 2000 : 1000;
    
    if (totalDots > maxDots) {
      visualSpacingX *= Math.ceil(totalDots / maxDots);
    }

    const startX = Math.max(1, length * 0.02);
    
    // Populate drawing points
    for (let x = startX; x <= length; x += visualSpacingX) {
      for (let i = 0; i < visualLateralCount; i++) {
        points.push({ x, y: i * visualLateralSpacing });
      }
    }
    
    return { points, isDrip, visualLateralCount, visualLateralSpacing };
  }, [designValues]);

  const toggleCompare = (design: any, e: React.MouseEvent) => {
    e.stopPropagation();
    if (compareSelection.find(d => d.id === design.id)) {
      setCompareSelection(compareSelection.filter(d => d.id !== design.id));
    } else {
      if (compareSelection.length >= 3) {
        alert("يمكنك مقارنة 3 تصميمات كحد أقصى");
        return;
      }
      setCompareSelection([...compareSelection, design]);
    }
  };

  return (
    <div className="flex h-screen w-full bg-[#f0f2f5] text-slate-900 font-sans overflow-hidden" dir="rtl">
      {/* Sidebar Navigation */}
      <motion.aside 
        initial={false}
        animate={{ width: isSidebarOpen ? '400px' : '0px' }}
        className="bg-white border-l border-slate-200 flex flex-col shrink-0 overflow-hidden shadow-2xl z-30"
      >
        <div className="p-6 border-b border-slate-200 flex items-center justify-between min-w-[400px]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
              <MessageSquare className="w-6 h-6" />
            </div>
            <div>
              <h1 className="font-black text-lg tracking-tight leading-none uppercase">إريجاتو AI</h1>
              <p className="text-[10px] text-emerald-600 font-bold tracking-widest mt-1 uppercase">مساعد الري الذكي</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button 
              onClick={handleNewSession}
              title="جلسة جديدة"
              className="text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 p-2 rounded-lg transition-all"
            >
              <RefreshCcw className="w-4 h-4" />
            </button>
            <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden text-slate-400 p-2 rounded-lg hover:bg-slate-50 transition-all">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Chat Feed */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 min-w-[400px] scroll-smooth">
          {messages.map((msg, idx) => (
            <motion.div 
              key={idx}
              initial={{ opacity: 0, x: msg.role === 'user' ? -20 : 20 }}
              animate={{ opacity: 1, x: 0 }}
              className={`flex flex-col ${msg.role === 'user' ? 'items-start' : 'items-end'}`}
            >
              <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed shadow-sm ${
                msg.role === 'user' 
                  ? 'bg-emerald-600 text-white rounded-br-none' 
                  : 'bg-slate-100 text-slate-700 rounded-bl-none'
              }`}>
                {msg.text}
              </div>
              {msg.timestamp && (
                <div className={`text-[10px] text-slate-400 mt-1.5 ${msg.role === 'user' ? 'pr-1' : 'pl-1'}`} dir="ltr">
                  {new Date(msg.timestamp).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </motion.div>
          ))}
          
          {!isTyping && messages.length > 0 && messages[messages.length - 1].role === 'model' && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-end gap-3 mt-4 w-full pr-8"
            >
              <div className="flex flex-wrap justify-end gap-2">
                {getSuggestions().map((sug, i) => (
                  <button
                    key={i}
                    onClick={() => handleSend(sug)}
                    className="bg-white border border-slate-200 text-slate-600 px-3 py-1.5 text-xs font-medium rounded-full hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200 transition-colors shadow-sm"
                  >
                    {sug}
                  </button>
                ))}
              </div>
              {analysis && (
                <button
                  onClick={() => {
                    if (window.innerWidth < 1024) setIsSidebarOpen(false);
                    dashboardRef.current?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  className="mt-1 bg-emerald-50 text-emerald-700 px-4 py-2 text-xs font-bold rounded-xl hover:bg-emerald-100 hover:scale-105 transition-all shadow-sm flex items-center gap-1.5 border border-emerald-200"
                >
                  <LayoutDashboard className="w-4 h-4" />
                  عرض لوحة التحكم الذكية
                </button>
              )}
            </motion.div>
          )}

          {isTyping && (
            <div className="flex justify-end pr-2">
              <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
            </div>
          )}
          <div ref={scrollRef} />
        </div>

        {/* Chat Input */}
        <div className="p-6 border-t border-slate-200 min-w-[400px]">
          <div className="relative">
            <textarea 
              rows={2}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="اكتب تفاصيل الأرض هنا..."
              className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm pr-12 focus:border-emerald-500 focus:bg-white outline-none transition-all resize-none"
            />
            <button 
              onClick={() => handleSend()}
              className="absolute left-3 bottom-3 bg-emerald-600 text-white p-2 rounded-xl hover:bg-emerald-700 transition-colors shadow-lg shadow-emerald-500/20"
            >
              <Send className="w-4 h-4 rtl:rotate-180" />
            </button>
          </div>
        </div>
      </motion.aside>

      {/* Toggle Button for Mobile */}
      {!isSidebarOpen && (
        <button 
          onClick={() => setIsSidebarOpen(true)}
          className="fixed bottom-6 left-6 p-4 bg-emerald-600 text-white rounded-2xl shadow-xl z-40 lg:hidden"
        >
          <Menu className="w-6 h-6" />
        </button>
      )}

      {/* Main Content Dashboard */}
      <main className="flex-1 flex flex-col relative overflow-y-auto">
        {/* Top Tool Bar */}
        <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between sticky top-0 z-50">
          <div className="flex items-center gap-4">
            <h2 className="text-xs font-black text-slate-800 uppercase tracking-tighter">
              {designName ? `التصميم الحالي: ${designName}` : 'لوحة التحكم الذكية'}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <button 
              disabled={!analysis || isExporting}
              onClick={() => setShowExportModal(true)}
              className={`flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-[10px] font-black transition-all shadow-lg shadow-blue-200 ${
                !analysis ? 'opacity-50 cursor-not-allowed bg-slate-300 shadow-none' : ''
              }`}
            >
              {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              خيارات التصدير PDF
            </button>
            <button 
              disabled={!analysis || isSaving}
              onClick={handleSaveDesign}
              className={`flex items-center gap-2 px-4 py-2 text-white rounded-xl text-[10px] font-black transition-all ${
                !analysis ? 'bg-slate-300' : 'bg-emerald-600 hover:bg-emerald-700 shadow-lg shadow-emerald-200'
              }`}
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              حفظ سحابي
            </button>

            {currentUser ? (
              <>
                <div className="hidden md:flex flex-col items-end mr-2">
                  <span className="text-[10px] font-black text-slate-800">{currentUser.displayName}</span>
                  <button onClick={handleLogout} className="text-[8px] font-bold text-red-500 uppercase hover:underline">تسجيل الخروج</button>
                </div>
                <button 
                  onClick={() => setShowLoadModal(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-[10px] font-black transition-all"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  تصميماتي
                </button>
              </>
            ) : (
              <button 
                onClick={handleLogin}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-[10px] font-black shadow-sm transition-all"
              >
                <div className="w-4 h-4 bg-red-500 rounded-full flex items-center justify-center text-[8px] text-white">G</div>
                تسجيل دخول
              </button>
            )}
          </div>
        </div>

        {!analysis ? (
          <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
            <motion.div 
              animate={{ y: [0, -10, 0] }}
              transition={{ repeat: Infinity, duration: 4 }}
              className="w-24 h-24 bg-emerald-100 text-emerald-600 rounded-3xl flex items-center justify-center mb-8"
            >
              <LayoutDashboard className="w-12 h-12" />
            </motion.div>
            <h2 className="text-2xl font-black text-slate-800 mb-2">لوحة التحكم في انتظار البيانات</h2>
            <p className="text-slate-500 max-w-sm">قم بتزويد المساعد بالمعلومات المطلوبة في الدردشة الجانبية لتوليد التصميم والرسوم البيانية.</p>
          </div>
        ) : (
          <div ref={dashboardRef} className="p-4 lg:p-10 space-y-10">
            {/* Header Summary */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div ref={summaryRef} className="bg-emerald-700 p-8 rounded-[2.5rem] text-white shadow-xl shadow-emerald-500/20 relative overflow-hidden flex flex-col justify-between">
                <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                  <Droplet className="w-32 h-32" />
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest mb-4 opacity-70">إجمالي المياه المطلوبة (Gross)</p>
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-4xl font-black italic">{analysis.charts.waterBalance.totalGross.toLocaleString()}</h3>
                    <span className="text-xs font-bold">متر مكعب</span>
                  </div>
                </div>
                
                <div className="mt-6 space-y-2 border-t border-white/10 pt-4">
                  <div className="flex justify-between text-[9px] uppercase font-black">
                    <span className="opacity-60">الاحتياج الصافي:</span>
                    <span>{analysis.charts.waterBalance.netRequirement.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[9px] uppercase font-black">
                    <span className="opacity-60">فواقد (كفاءة + تسرب):</span>
                    <span>{(analysis.charts.waterBalance.efficiencyLoss + analysis.charts.waterBalance.deepPercolation).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-[9px] uppercase font-black text-blue-300">
                    <span className="opacity-60">مساهمة الأمطار:</span>
                    <span>-{analysis.charts.waterBalance.rainfallEffective.toLocaleString()}</span>
                  </div>
                </div>
              </div>
              
              <div ref={demandRef} className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm col-span-2">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-sm font-black flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-emerald-600" /> الاحتياج المائي الشهري (ETc)
                  </h3>
                  <Download className="w-4 h-4 text-slate-300 pointer-events-auto cursor-pointer" />
                </div>
                <div className="h-48 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={analysis.charts.seasonalWaterDemand}>
                      <defs>
                        <linearGradient id="colorAmount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8'}} />
                      <YAxis hide />
                      <Tooltip 
                        contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                        labelStyle={{fontWeight: 'bold', marginBottom: '4px'}}
                      />
                      <Area type="monotone" dataKey="amount" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorAmount)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Weather Forecast Row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
              <div ref={weatherRef} className="lg:col-span-2 bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                <div className="flex items-center justify-between mb-8">
                   <h3 className="text-sm font-black flex items-center gap-2">
                     <Cloud className="w-4 h-4 text-sky-500" /> توقعات الطقس والتأثير على الجدولة
                   </h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {analysis.charts.weatherForecast.map((w, idx) => (
                    <div key={idx} className="bg-slate-50 rounded-[2.5rem] p-6 lg:p-8 flex flex-col justify-between border border-slate-100 hover:border-sky-100 transition-all group relative overflow-hidden">
                       <div className="absolute top-0 right-0 -mr-6 -mt-6 opacity-5 pointer-events-none">
                          <Wind className="w-32 h-32" />
                       </div>
                       <div className="flex flex-col mb-4">
                          <span className="text-[10px] font-black text-slate-400 mb-1 uppercase tracking-widest">{w.day}</span>
                          <div className="flex items-center gap-3">
                             <div className="p-3 bg-white rounded-2xl shadow-sm text-slate-800">
                                {w.condition === 'sun' && <Sun className="w-6 h-6 text-amber-500" />}
                                {w.condition === 'cloud' && <Cloud className="w-6 h-6 text-slate-400" />}
                                {w.condition === 'rain' && <CloudRain className="w-6 h-6 text-sky-500" />}
                             </div>
                             <div className="flex flex-col">
                                <span className="text-2xl font-black text-slate-800">{w.temp}°</span>
                                <span className="text-[10px] font-bold text-slate-500">{w.precipitationProb}% مطر</span>
                             </div>
                          </div>
                       </div>
                       
                       {/* Wind Details Inside the Weather Card */}
                       <div className="mt-4 pt-4 border-t border-slate-200/60 w-full flex flex-col gap-2 relative z-10">
                          <div className="flex items-center justify-between text-xs font-bold">
                             <span className="flex items-center gap-1.5 text-slate-500"><Wind className="w-3.5 h-3.5 text-sky-400" /> سرعة الرياح:</span>
                             <span className="text-sky-600 font-black">{w.windSpeed} كم/س</span>
                          </div>
                          <div className="text-[9.5px] leading-relaxed text-slate-400 italic bg-white/50 p-2 rounded-xl border border-slate-100">
                             {w.windEffect}
                          </div>
                       </div>
                    </div>
                  ))}
                </div>
              </div>

              <div ref={lossesRef} className="bg-white p-8 rounded-[2.5rem] border border-slate-200 shadow-sm">
                <h3 className="text-sm font-black mb-6 flex items-center gap-2">
                  <Waves className="w-4 h-4 text-emerald-600" /> تحليل الفواقد والكفاءة
                </h3>
                <div className="h-40 w-full mb-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={[
                          { name: 'احتياج صافي', value: analysis.charts.waterBalance.netRequirement },
                          { name: 'فواقد كفاءة', value: analysis.charts.waterBalance.efficiencyLoss },
                          { name: 'تسرب عميق', value: analysis.charts.waterBalance.deepPercolation }
                        ]}
                        innerRadius={45}
                        outerRadius={65}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        <Cell fill="#10b981" />
                        <Cell fill="#fcd34d" />
                        <Cell fill="#f87171" />
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2">
                   <div className="flex justify-between items-center text-[10px] font-bold">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                        <span className="text-slate-500">مياه مستفاد منها</span>
                      </div>
                      <span className="text-slate-800">{Math.round((analysis.charts.waterBalance.netRequirement / analysis.charts.waterBalance.totalGross) * 100)}%</span>
                   </div>
                   <div className="flex justify-between items-center text-[10px] font-bold">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-amber-400"></div>
                        <span className="text-slate-500">فواقد كفاءة الرشاشات</span>
                      </div>
                      <span className="text-slate-800">{Math.round((analysis.charts.waterBalance.efficiencyLoss / analysis.charts.waterBalance.totalGross) * 100)}%</span>
                   </div>
                </div>
              </div>
            </div>

            {/* Middle Section - Scheduling Chart (Full Width) */}
            <div ref={schedulingRef} className="bg-white p-10 rounded-[3rem] border border-slate-200 shadow-sm flex flex-col">
              <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-4">
                  <h3 className="text-sm font-black flex items-center gap-2">
                    <History className="w-4 h-4 text-blue-600" /> جدولة الري ورطوبة التربة (نمط CROPWAT)
                  </h3>
                  {/* Current Status Badge */}
                  <div className={`px-4 py-1.5 rounded-full text-[9px] font-black uppercase flex items-center gap-2 border ${
                    analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.permanentWiltingPoint
                      ? 'bg-red-50 border-red-200 text-red-600 shadow-sm shadow-red-100'
                      : analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.temporaryWiltingPoint
                        ? 'bg-amber-50 border-amber-200 text-amber-600 shadow-sm shadow-amber-100'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-600 shadow-sm shadow-emerald-100'
                  }`}>
                    <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                      analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.permanentWiltingPoint
                        ? 'bg-red-600'
                        : analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.temporaryWiltingPoint
                          ? 'bg-amber-600'
                          : 'bg-emerald-600'
                    }`}></div>
                    الحالة الحالية: {
                      analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.permanentWiltingPoint
                        ? 'خطر ذبول دائم'
                        : analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.temporaryWiltingPoint
                          ? 'إجهاد مائي حاد'
                          : 'رطوبة مثالية'
                    }
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                    <span className="text-[8px] font-bold text-slate-400 uppercase">خطر الذبول</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-amber-500"></div>
                    <span className="text-[8px] font-bold text-slate-400 uppercase">إجهاد مائي</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                    <span className="text-[8px] font-bold text-slate-400 uppercase">الرطوبة</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                    <span className="text-[8px] font-bold text-slate-400 uppercase">الري</span>
                  </div>
                </div>
              </div>

              <div className="h-[400px]">
                {analysis.charts.schedulingLog && analysis.charts.schedulingLog.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={analysis.charts.schedulingLog}>
                      <defs>
                        <linearGradient id="colorMoisture" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4}/>
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis 
                        dataKey="day" 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{fontSize: 9, fill: '#94a3b8'}}
                        label={{ value: 'أيام الدورة', position: 'insideBottom', offset: -5, fontSize: 10, fill: '#94a3b8' }}
                      />
                      <YAxis 
                        domain={[0, 100]} 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{fontSize: 9, fill: '#94a3b8'}}
                        label={{ value: 'الرطوبة %', angle: -90, position: 'insideLeft', fontSize: 10, fill: '#94a3b8' }}
                      />
                      <Tooltip 
                        content={({ active, payload, label }) => {
                          if (active && payload && payload.length) {
                            const val = payload[0].value as number;
                            let status = "حالة جيدة";
                            let color = "text-blue-600";
                            if (val <= analysis.charts.soilHydrology.permanentWiltingPoint) {
                              status = "ذبول دائم - خطر!";
                              color = "text-red-600";
                            } else if (val <= analysis.charts.soilHydrology.temporaryWiltingPoint) {
                              status = "إجهاد مائي - ري فوراً";
                              color = "text-amber-600";
                            }
                            return (
                              <div className="bg-white/95 backdrop-blur p-4 rounded-2xl shadow-2xl border border-slate-100 min-w-[150px]">
                                <p className="text-[10px] font-black text-slate-400 uppercase mb-2">اليوم {label}</p>
                                <div className="space-y-1">
                                  <div className="flex justify-between items-center gap-4">
                                    <span className="text-xs font-bold text-slate-500">الرطوبة:</span>
                                    <span className={`text-sm font-black ${color}`}>{val}%</span>
                                  </div>
                                  <p className={`text-[9px] font-black uppercase ${color}`}>{status}</p>
                                  {payload[1] && (payload[1].value as number) > 0 && (
                                    <div className="pt-1 mt-1 border-t border-slate-100">
                                      <span className="text-[9px] font-bold text-emerald-600">ري مضاف: {(payload[1].value as number)}%</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      
                      {/* Critical Zones */}
                      <ReferenceArea 
                        y1={0} 
                        y2={analysis.charts.soilHydrology.permanentWiltingPoint} 
                        {...({ fill: "#fef2f2", fillOpacity: 0.6 } as any)}
                      />
                      <ReferenceArea 
                        y1={analysis.charts.soilHydrology.permanentWiltingPoint} 
                        y2={analysis.charts.soilHydrology.temporaryWiltingPoint} 
                        {...({ fill: "#fffbeb", fillOpacity: 0.6 } as any)}
                      />

                      <ReferenceLine y={analysis.charts.soilHydrology.fieldCapacity} stroke="#10b981" strokeDasharray="3 3">
                        <Label value="FC" position="right" fill="#10b981" fontSize={8} fontWeight="bold" />
                      </ReferenceLine>
                      <ReferenceLine y={analysis.charts.soilHydrology.temporaryWiltingPoint} stroke="#f59e0b" strokeDasharray="3 3">
                        <Label value="TWP" position="right" fill="#f59e0b" fontSize={8} fontWeight="bold" />
                      </ReferenceLine>
                      <ReferenceLine y={analysis.charts.soilHydrology.permanentWiltingPoint} stroke="#ef4444" strokeDasharray="3 3">
                        <Label value="PWP" position="right" fill="#ef4444" fontSize={8} fontWeight="bold" />
                      </ReferenceLine>
                      
                      <Area type="monotone" dataKey="moisture" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorMoisture)" />
                      <Area type="stepAfter" dataKey="irrigation" stroke="#10b981" strokeWidth={0} fill="#10b981" fillOpacity={0.4} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-slate-300 text-xs italic">
                    جاري محاكاة بيانات الجدولة...
                  </div>
                )}
              </div>
              
              <div className="mt-6 p-4 bg-blue-50 rounded-2xl border border-blue-100 italic text-[10px] text-blue-600 leading-relaxed text-center">
                * يوضح الرسم تغير رطوبة التربة عبر الموسم: تنخفض الرطوبة تدريجياً بالنتح وترتفع فوراً عند الري.
              </div>
            </div>

            {/* Bottom Row - Root Depth & Manual Controls */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
              {/* Root Zone Depth */}
              <div ref={rootZoneRef} className="bg-emerald-950 text-white p-10 rounded-[3rem] shadow-xl relative overflow-hidden">
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'repeating-linear-gradient(45deg, #fff 0, #fff 1px, transparent 0, transparent 50%)', backgroundSize: '10px 10px' }}></div>
                <div className="flex items-center justify-between mb-10 relative z-10">
                  <h3 className="text-sm font-black flex items-center gap-2 text-emerald-400">
                    <Sprout className="w-4 h-4" /> عمق منطقة الجذور الفعّالة
                  </h3>
                  {/* Root Health Badge */}
                  <div className={`px-4 py-1.5 rounded-full text-[9px] font-black uppercase flex items-center gap-2 border ${
                    analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.permanentWiltingPoint
                      ? 'bg-red-500/20 border-red-400/30 text-red-100'
                      : analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.temporaryWiltingPoint
                        ? 'bg-amber-500/20 border-amber-400/30 text-amber-100'
                        : 'bg-emerald-500/20 border-emerald-400/30 text-emerald-100'
                  }`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.permanentWiltingPoint
                        ? 'bg-red-400 animate-ping'
                        : 'bg-emerald-400'
                    }`}></div>
                    حالة الجذور: {
                      analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.permanentWiltingPoint
                        ? 'مجهدة بشدة'
                        : analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.temporaryWiltingPoint
                          ? 'إجهاد مائي'
                          : 'نمو مثالي'
                    }
                  </div>
                </div>

                <div className="flex-1 flex items-center justify-center py-5 relative z-10">
                  <div className="relative w-48 h-64 flex flex-col items-center">
                    {/* Plant Base */}
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-8">
                       <Sprout className={`w-12 h-12 transition-colors duration-500 ${
                         analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.permanentWiltingPoint
                           ? 'text-amber-700'
                           : 'text-emerald-400'
                       }`} />
                    </div>

                    {/* Soil Container */}
                    <div className="w-full h-full border-x-4 border-white/10 relative overflow-hidden bg-white/5 rounded-b-2xl">
                      {/* Active Zone Visualization */}
                      <div 
                        className="absolute inset-x-0 bottom-0 bg-emerald-500/20 border-t-2 border-emerald-400 border-dashed"
                        style={{ 
                          height: `${((overrides.rootDepth ? (overrides.rootDepth * 0.7) : analysis.charts.rootZone.activeDepth) / (overrides.rootDepth || analysis.charts.rootZone.totalDepth)) * 100}%` 
                        }}
                      >
                         <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[9px] font-bold text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded-md whitespace-nowrap">
                            المنطقة النشطة: {overrides.rootDepth ? Math.round(overrides.rootDepth * 0.7) : analysis.charts.rootZone.activeDepth}سم
                         </div>
                      </div>

                      {/* Current Water Level Overlay */}
                      <motion.div 
                        initial={false}
                        animate={{ height: `${analysis.charts.soilHydrology.currentLevel}%` }}
                        className={`absolute inset-x-0 bottom-0 opacity-40 transition-colors duration-500 ${
                          analysis.charts.soilHydrology.currentLevel <= analysis.charts.soilHydrology.permanentWiltingPoint
                            ? 'bg-red-600'
                            : 'bg-blue-500'
                        }`}
                      />

                      {/* Root Filaments (Cubic bezier for decoration) */}
                      <svg className="absolute inset-0 w-full h-full opacity-30" viewBox="0 0 100 100" preserveAspectRatio="none">
                         <path d="M50,0 Q50,30 30,50 T30,80" stroke="white" fill="none" strokeWidth="0.5" />
                         <path d="M50,0 Q50,20 70,40 T70,70" stroke="white" fill="none" strokeWidth="0.5" />
                         <path d="M50,0 Q50,40 50,90" stroke="white" fill="none" strokeWidth="0.5" />
                      </svg>
                    </div>

                    {/* Total Depth Indicator */}
                    <div className="absolute -right-8 top-0 bottom-0 flex flex-col justify-between py-2">
                       <div className="w-2 h-px bg-white/20"></div>
                       <div className="h-full w-px bg-white/10 self-center"></div>
                       <div className="w-2 h-px bg-white/20"></div>
                       <div className="absolute top-1/2 -translate-y-1/2 left-4 text-[10px] font-bold text-white/40 rotate-90 whitespace-nowrap">
                          {overrides.rootDepth || analysis.charts.rootZone.totalDepth}سم
                       </div>
                    </div>
                  </div>
                </div>
                <div className="mt-6 text-center">
                   <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">{analysis.charts.rootZone.cropName} - نمط الجذور المتوقع</p>
                </div>
              </div>

              {/* Manual Design Overrides */}
              <div ref={networkOptionsRef} className="bg-white p-10 rounded-[3rem] border border-slate-200 shadow-sm flex flex-col">
                <h3 className="text-sm font-black mb-10 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-600" /> تعديل مواصفات الشبكة والكفاءة
                </h3>
                <div className="space-y-8">
                  <div className="space-y-4">
                    <div className="flex justify-between items-center">
                      <label className="text-[10px] font-black text-slate-400 uppercase">نوع الرشاشات وكفاءة النظام</label>
                      <span className="text-[10px] font-black text-emerald-600 px-2 py-1 bg-emerald-50 rounded-lg">{(overrides.sprinklerEfficiency || analysis.design.sprinklerEfficiency)}%</span>
                    </div>
                    
                    <div className="grid grid-cols-4 gap-2">
                       {[
                         { label: 'تنقيط', val: 90 },
                         { label: 'دوار', val: 75 },
                         { label: 'تصادمي', val: 65 },
                         { label: 'رذاذ', val: 55 }
                       ].map(preset => (
                         <button 
                           key={preset.label}
                           onClick={() => setOverrides(prev => ({ ...prev, sprinklerEfficiency: preset.val }))}
                           className={`py-2 rounded-xl text-[9px] font-black transition-all border ${
                             (overrides.sprinklerEfficiency || analysis.design.sprinklerEfficiency) === preset.val 
                               ? 'bg-emerald-600 text-white border-emerald-600 shadow-lg shadow-emerald-200' 
                               : 'bg-slate-50 text-slate-400 border-slate-100 hover:border-emerald-200'
                           }`}
                         >
                           {preset.label}
                         </button>
                       ))}
                    </div>

                    <input 
                      type="range" 
                      min="40" 
                      max="95" 
                      step="5"
                      value={overrides.sprinklerEfficiency || analysis.design.sprinklerEfficiency}
                      onChange={(e) => setOverrides(prev => ({ ...prev, sprinklerEfficiency: parseInt(e.target.value) }))}
                      className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                    />
                    <div className="flex justify-between text-[8px] font-bold text-slate-300 uppercase px-1">
                       <span>منخفض (40%)</span>
                       <span>مثالي (95%)</span>
                    </div>
                    <p className="text-[9px] text-slate-400 leading-relaxed italic">تعديل الكفاءة يغير "إجمالي المياه المطلوبة"؛ الكفاءة المنخفضة تزيد من ضخ المياه لتعويض التوزيع غير المنتظم.</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase">قطر الخط الرئيسي</label>
                    <input 
                      type="text" 
                      value={overrides.mainLine || analysis.design.mainLine}
                      onChange={(e) => setOverrides(prev => ({ ...prev, mainLine: e.target.value }))}
                      className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm focus:border-emerald-500 outline-none transition-all"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase">قطر الخطوط الفرعية</label>
                    <input 
                      type="text" 
                      value={overrides.laterals || analysis.design.laterals}
                      onChange={(e) => setOverrides(prev => ({ ...prev, laterals: e.target.value }))}
                      className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm focus:border-emerald-500 outline-none transition-all"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase">قطر الموزعات (Sub-main)</label>
                    <input 
                      type="text" 
                      value={overrides.subMainLine || analysis.design.subMainLine}
                      onChange={(e) => setOverrides(prev => ({ ...prev, subMainLine: e.target.value }))}
                      className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm focus:border-emerald-500 outline-none transition-all"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase">العمق الإجمالي للجذور (Root Depth - cm)</label>
                    <input 
                      type="number" 
                      value={overrides.rootDepth || analysis.charts.rootZone.totalDepth}
                      onChange={(e) => setOverrides(prev => ({ ...prev, rootDepth: parseInt(e.target.value) || 0 }))}
                      className="w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm focus:border-emerald-500 outline-none transition-all"
                    />
                  </div>
                </div>
                <div className="mt-auto pt-6 italic text-[10px] text-slate-400">
                  * سيتم تحديث الرسم التوضيحي والبيانات فوراً عند تغيير القيم.
                </div>
              </div>
            </div>

            {/* Monthly Recommendations Table */}
            <div className="bg-white p-10 rounded-[3rem] border border-slate-200 shadow-sm overflow-hidden">
               <div className="flex items-center justify-between mb-8">
                  <h3 className="text-sm font-black flex items-center gap-2 text-slate-800">
                    <Sprout className="w-4 h-4 text-emerald-600" /> الجدول الاسترشادى الشهرى (توصيات هندسية)
                  </h3>
               </div>
               <div className="overflow-x-auto">
                 <table className="w-full text-right border-collapse">
                   <thead>
                     <tr className="border-b border-slate-100 italic">
                       <th className="py-4 px-4 text-[10px] uppercase text-slate-400 font-black">الشهر</th>
                       <th className="py-4 px-4 text-[10px] uppercase text-slate-400 font-black">تكرار الري</th>
                       <th className="py-4 px-4 text-[10px] uppercase text-slate-400 font-black">مدة التشغيل</th>
                       <th className="py-4 px-4 text-[10px] uppercase text-slate-400 font-black text-left">نصيحة فنية</th>
                     </tr>
                   </thead>
                   <tbody>
                     {analysis.monthlyRecommendations.map((rec, idx) => (
                       <tr key={idx} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors group">
                         <td className="py-5 px-4">
                            <span className="text-xs font-black text-slate-800 group-hover:text-emerald-700">{rec.month}</span>
                         </td>
                         <td className="py-5 px-4 text-xs font-bold text-slate-600">{rec.frequency}</td>
                         <td className="py-5 px-4 text-xs font-medium text-slate-500">
                            <span className="bg-blue-50 text-blue-600 px-2 py-1 rounded-lg text-[10px] font-black">{rec.duration}</span>
                         </td>
                         <td className="py-5 px-4 text-[10px] text-slate-400 leading-relaxed italic max-w-xs text-left">
                           {rec.tip}
                         </td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
            </div>

            {/* Plot Design Canvas */}
            <div ref={blueprintRef} className="bg-white border border-slate-200 rounded-[3.5rem] overflow-hidden shadow-sm flex flex-col p-8 md:p-10 relative lg:min-h-[700px] gap-8">
              <div className="absolute inset-0 opacity-[0.02] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#000 1.2px, transparent 1.2px)', backgroundSize: '24px 24px' }}></div>
              
              {/* Header & Controls */}
              <div className="flex justify-between items-center relative z-10 w-full">
                 <h3 className="text-xl font-black text-slate-800">المخطط الهندسي</h3>
                 <div className="flex items-center bg-white shadow-xl border border-slate-200 rounded-2xl p-1 gap-1">
                    <button onClick={() => setZoom(z => Math.max(0.2, z - 0.2))} className="p-2 hover:bg-slate-100 rounded-xl transition-all group">
                      <Minimize className="w-4 h-4 text-slate-500" />
                    </button>
                    <span className="text-xs font-mono font-black text-slate-900 min-w-[3rem] text-center">{Math.round(zoom * 100)}%</span>
                    <button onClick={() => setZoom(z => Math.min(3, z + 0.2))} className="p-2 hover:bg-slate-100 rounded-xl transition-all group">
                      <Maximize className="w-4 h-4 text-slate-500" />
                    </button>
                 </div>
              </div>

              {/* Map SVG Wrapper (Modern Light UI/UX Style) */}
              <div className="flex-1 w-[95%] mx-auto flex items-center justify-center relative overflow-hidden min-h-[500px] bg-white border border-slate-200 rounded-t-2xl shadow-inner">
                <motion.div 
                  style={{ scale: zoom }}
                  className="relative flex items-center justify-center w-full h-full"
                  layout
                >
                  <svg
                    width="100%" 
                    height="100%"
                    style={{ maxHeight: '75vh', minHeight: '500px' }}
                    viewBox={`-${Math.max(20, designValues.length * 0.15)} -${Math.max(20, designValues.width * 0.15)} ${designValues.length + Math.max(40, designValues.length * 0.3)} ${designValues.width + Math.max(40, designValues.width * 0.3)}`}
                    preserveAspectRatio="xMidYMid meet"
                    className="transition-all duration-300 overflow-visible"
                  >
                    <defs>
                      <pattern id="cadGrid" width={Math.max(1, designValues.length * 0.02)} height={Math.max(1, designValues.width * 0.02)} patternUnits="userSpaceOnUse">
                        <path d={`M ${Math.max(1, designValues.length * 0.02)} 0 L 0 0 0 ${Math.max(1, designValues.width * 0.02)}`} fill="none" stroke="#f1f5f9" strokeWidth={Math.max(0.1, designValues.length * 0.001)}/>
                      </pattern>
                      <pattern id="cadGridLarge" width={Math.max(5, designValues.length * 0.1)} height={Math.max(5, designValues.width * 0.1)} patternUnits="userSpaceOnUse">
                        <rect width="100%" height="100%" fill="url(#cadGrid)" />
                        <path d={`M ${Math.max(5, designValues.length * 0.1)} 0 L 0 0 0 ${Math.max(5, designValues.width * 0.1)}`} fill="none" stroke="#e2e8f0" strokeWidth={Math.max(0.2, designValues.length * 0.002)}/>
                      </pattern>
                    </defs>

                    {/* Infinite Grid Background */}
                    <rect x="-1000%" y="-1000%" width="2000%" height="2000%" fill="#ffffff" />
                    <rect x="-1000%" y="-1000%" width="2000%" height="2000%" fill="url(#cadGridLarge)" />

                    {/* AutoCAD-like Dimensions (Dark Blue) */}
                    <g stroke="#64748b" strokeWidth={Math.max(0.1, designValues.length * 0.003)} fill="none" fontFamily="sans-serif" fontSize={Math.max(1, designValues.length * 0.035)}>
                      {/* Top X dimension */}
                      <line x1="0" y1={-designValues.width * 0.08} x2={designValues.length} y2={-designValues.width * 0.08} />
                      <line x1="0" y1={-designValues.width * 0.09} x2="0" y2={-designValues.width * 0.07} strokeWidth={Math.max(0.2, designValues.length * 0.005)} />
                      <line x1={designValues.length} y1={-designValues.width * 0.09} x2={designValues.length} y2={-designValues.width * 0.07} strokeWidth={Math.max(0.2, designValues.length * 0.005)} />
                      
                      {/* Architectural Ticks */}
                      <path d={`M ${-designValues.length*0.01},${-designValues.width*0.09} L ${designValues.length*0.01},${-designValues.width*0.07} M ${-designValues.length*0.01},${-designValues.width*0.07} L ${designValues.length*0.01},${-designValues.width*0.09}`} strokeWidth={Math.max(0.1, designValues.length * 0.004)} />
                      <path d={`M ${designValues.length - designValues.length*0.01},${-designValues.width*0.09} L ${designValues.length + designValues.length*0.01},${-designValues.width*0.07} M ${designValues.length - designValues.length*0.01},${-designValues.width*0.07} L ${designValues.length + designValues.length*0.01},${-designValues.width*0.09}`} strokeWidth={Math.max(0.1, designValues.length * 0.004)} />
                      
                      {/* Text */}
                      <text x={designValues.length / 2} y={-designValues.width * 0.08 - designValues.width * 0.015} fill="#475569" textAnchor="middle" stroke="#ffffff" strokeWidth={Math.max(0.3, designValues.length * 0.008)} paintOrder="stroke" fontWeight="bold">X = {designValues.length}m</text>

                      {/* Left Y dimension */}
                      <line x1={-designValues.length * 0.08} y1="0" x2={-designValues.length * 0.08} y2={designValues.width} />
                      <line x1={-designValues.length * 0.09} y1="0" x2={-designValues.length * 0.07} y2="0" strokeWidth={Math.max(0.2, designValues.length * 0.005)} />
                      <line x1={-designValues.length * 0.09} y1={designValues.width} x2={-designValues.length * 0.07} y2={designValues.width} strokeWidth={Math.max(0.2, designValues.length * 0.005)} />
                      
                      <path d={`M ${-designValues.length*0.09},${-designValues.width*0.01} L ${-designValues.length*0.07},${designValues.width*0.01} M ${-designValues.length*0.09},${designValues.width*0.01} L ${-designValues.length*0.07},${-designValues.width*0.01}`} strokeWidth={Math.max(0.1, designValues.length * 0.004)} />
                      <path d={`M ${-designValues.length*0.09},${designValues.width - designValues.width*0.01} L ${-designValues.length*0.07},${designValues.width + designValues.width*0.01} M ${-designValues.length*0.09},${designValues.width + designValues.width*0.01} L ${-designValues.length*0.07},${designValues.width - designValues.width*0.01}`} strokeWidth={Math.max(0.1, designValues.length * 0.004)} />
                      
                      <g transform={`translate(${-designValues.length * 0.08 - designValues.length * 0.015}, ${designValues.width / 2}) rotate(-90)`}>
                        <text x="0" y="0" fill="#475569" textAnchor="middle" stroke="#ffffff" strokeWidth={Math.max(0.3, designValues.length * 0.008)} paintOrder="stroke" fontWeight="bold">Y = {designValues.width}m</text>
                      </g>
                    </g>

                    {/* Plot Boundary */}
                    <rect x="0" y="0" width={designValues.length} height={designValues.width} fill="none" stroke="#94a3b8" strokeWidth={Math.max(0.2, designValues.length * 0.005)} strokeDasharray={`${Math.max(2, designValues.length*0.05)},${Math.max(2, designValues.length*0.05)}`} />

                    {/* Zones/Partitions (Soft Blue) */}
                    {designValues.zones?.map((zone: any) => (
                      <rect 
                        key={`zone-${zone.id}`}
                        x={zone.x} 
                        y={zone.y} 
                        width={zone.width} 
                        height={zone.height} 
                        fill={zone.color || '#0ea5e9'} 
                        fillOpacity="0.05" 
                        stroke={zone.color || '#bae6fd'} 
                        strokeWidth={Math.max(0.1, designValues.length * 0.002)} 
                        strokeDasharray={`${Math.max(1, designValues.length*0.02)},${Math.max(1, designValues.length*0.02)}`}
                      />
                    ))}

                    {/* Main Line (Deep Blue) */}
                    <line 
                      x1={Math.max(1, designValues.length * 0.02)} 
                      y1="0" 
                      x2={Math.max(1, designValues.length * 0.02)} 
                      y2={designValues.width} 
                      stroke="#1e3a8a" 
                      strokeWidth={Math.max(0.5, (parseInt(designValues.mainLine) / 60) * (designValues.length * 0.01) || Math.max(0.5, designValues.length * 0.01))} 
                      strokeLinecap="square"
                    />

                    {/* Sub Main / Lateral Lines (Blue) */}
                    {visualLateralCount > 0 && Array.from({ length: visualLateralCount }).map((_, i) => {
                      const lateralY = i * visualLateralSpacing;
                      return (
                        <g key={`lateral-${i}`}>
                          {/* Pipe */}
                          <line 
                            x1={Math.max(1, designValues.length * 0.02)} 
                            y1={lateralY} 
                            x2={designValues.length} 
                            y2={lateralY} 
                            stroke="#3b82f6" 
                            strokeWidth={Math.max(0.2, (parseInt(designValues.laterals) || 0) / 100 * (designValues.length * 0.005) || Math.max(0.2, designValues.length * 0.004))} 
                          />
                          {/* Connection Node (T-Junction) */}
                          <rect x={Math.max(1, designValues.length * 0.02) - Math.max(0.3, designValues.length * 0.005)} y={lateralY - Math.max(0.3, designValues.length * 0.005)} width={Math.max(0.6, designValues.length * 0.01)} height={Math.max(0.6, designValues.length * 0.01)} fill="#1e3a8a" />
                        </g>
                      );
                    })}

                    {/* Sprinklers / Drippers (Sky Blue Crosshair or Dot) */}
                    {sprinklers.map((p, i) => {
                      const avgWind = analysis.charts.weatherForecast[0]?.windSpeed || 0;
                      // Determine wind deflection offset and squash based on speed
                      // E.g., 20 km/h wind might shift the radius by 30% and squash the Y axis
                      const isAffectedByWind = !isDrip && avgWind > 5;
                      const driftX = isAffectedByWind ? (Math.min(avgWind / 40, 0.6) * designValues.sprinklerRadius) : 0;
                      const radiusY = isAffectedByWind ? designValues.sprinklerRadius * Math.max(0.6, 1 - (avgWind / 100)) : designValues.sprinklerRadius;

                      return (
                        <g key={`sprinkler-${i}`}>
                          {/* Normal Defended Outline (to show optimal boundary) */}
                          {!isDrip && isAffectedByWind && (
                            <circle cx={p.x} cy={p.y} r={designValues.sprinklerRadius} fill="none" stroke="#e2e8f0" strokeWidth={Math.max(0.05, designValues.length * 0.001)} strokeDasharray={`${Math.max(0.5, designValues.length*0.01)},${Math.max(1, designValues.length*0.02)}`} />
                          )}
                          
                          {/* Coverage Area (Distorted by wind if applicable) */}
                          {!isDrip && (
                            <ellipse 
                              cx={p.x + driftX} 
                              cy={p.y} 
                              rx={designValues.sprinklerRadius} 
                              ry={radiusY} 
                              fill={isAffectedByWind ? "#0ea5e9" : "none"} 
                              fillOpacity={isAffectedByWind ? "0.08" : "0"}
                              stroke={isAffectedByWind ? "#0284c7" : "#bae6fd"} 
                              strokeWidth={Math.max(0.1, designValues.length * 0.002)} 
                              strokeDasharray={`${Math.max(0.5, designValues.length*0.01)},${Math.max(1, designValues.length*0.02)}`} 
                            />
                          )}
                          
                          {/* Droplet / Point Representation */}
                          {isDrip ? (
                            <circle cx={p.x} cy={p.y} r={Math.max(0.1, designValues.length * 0.002)} fill="#0ea5e9" />
                          ) : (
                            <g>
                              <path d={`M ${p.x - Math.max(0.5, designValues.length * 0.01)},${p.y} L ${p.x + Math.max(0.5, designValues.length * 0.01)},${p.y} M ${p.x},${p.y - Math.max(0.5, designValues.length * 0.01)} L ${p.x},${p.y + Math.max(0.5, designValues.length * 0.01)}`} stroke="#0284c7" strokeWidth={Math.max(0.15, designValues.length * 0.003)} fill="none" />
                              <circle cx={p.x} cy={p.y} r={Math.max(0.2, designValues.length * 0.003)} fill="#0284c7" />
                            </g>
                          )}
                        </g>
                      );
                    })}

                    {/* Valves (Red Bowtie) */}
                    {designValues.valves?.map((v: any, i: number) => {
                      const vScale = Math.max(0.5, designValues.length * 0.015);
                      return (
                        <g key={`valve-${i}`} transform={`translate(${v.x}, ${v.y})`}>
                          <path d={`M -${vScale},-${vScale*0.8} L ${vScale},${vScale*0.8} M -${vScale},${vScale*0.8} L ${vScale},-${vScale*0.8} M -${vScale},-${vScale*0.8} L -${vScale},${vScale*0.8} M ${vScale},${vScale*0.8} L ${vScale},-${vScale*0.8} z`} fill="none" stroke="#dc2626" strokeWidth={Math.max(0.2, designValues.length * 0.004)} strokeLinejoin="round" />
                        </g>
                      );
                    })}

                    {/* Pump (Amber Circle with Triangle) */}
                    {designValues.pump && (
                      <g transform={`translate(${designValues.pump.x}, ${designValues.pump.y})`}>
                        <circle cx="0" cy="0" r={Math.max(1, designValues.length * 0.02)} fill="none" stroke="#d97706" strokeWidth={Math.max(0.2, designValues.length * 0.004)} />
                        <path d={`M -${Math.max(0.6, designValues.length * 0.01)},-${Math.max(0.4, designValues.length * 0.008)} L ${Math.max(0.6, designValues.length * 0.01)},0 L -${Math.max(0.6, designValues.length * 0.01)},${Math.max(0.4, designValues.length * 0.008)} Z`} fill="none" stroke="#d97706" strokeWidth={Math.max(0.2, designValues.length * 0.004)} />
                      </g>
                    )}
                  </svg>
                </motion.div>
              </div>

              {/* Bottom Legend (Modern UI Dashboard Style) */}
              <div className="relative w-[95%] mx-auto flex flex-wrap justify-center sm:justify-between items-center bg-white border border-slate-200 border-t-0 text-slate-600 rounded-b-lg shadow-lg font-sans text-xs sm:text-sm tracking-wide">
                {/* Status Bar style items */}
                <div className="flex flex-wrap lg:border-r border-slate-200">
                  <div className="px-3 sm:px-4 py-3 lg:border-r border-slate-200 cursor-default flex items-center gap-2" title={`خط رئيسي بقطر ${designValues.mainLine} ملم`}>
                    <div className="w-4 h-1 bg-[#1e3a8a] rounded-full"></div>
                    <span className="font-semibold text-slate-800">MAIN: {designValues.mainLine}mm</span>
                  </div>
                  <div className="px-3 sm:px-4 py-3 lg:border-r border-slate-200 cursor-default flex items-center gap-2" title={`خطوط فرعية بقطر ${designValues.laterals} ملم`}>
                    <div className="w-4 h-[2px] bg-[#3b82f6] rounded-full"></div>
                    <span className="font-medium">LAT: {designValues.laterals}mm</span>
                  </div>
                  <div className="px-3 sm:px-4 py-3 lg:border-r border-slate-200 cursor-default flex items-center gap-2">
                    <div className="w-3 h-3 relative flex items-center justify-center">
                      <div className="absolute w-3 h-[2px] bg-[#0284c7]"></div>
                      <div className="absolute h-3 w-[2px] bg-[#0284c7]"></div>
                    </div>
                    <span className="font-medium">{isDrip ? 'نقاط (DRIPPER)' : `رشاش (قطر ${designValues.sprinklerRadius}m)`}</span>
                  </div>
                  <div className="px-3 sm:px-4 py-3 lg:border-r border-slate-200 cursor-default flex items-center gap-2">
                    <svg viewBox="-2 -2 4 4" className="w-3 h-3 text-[#dc2626]">
                      <path d="M-1.2,-0.8 L1.2,0.8 M-1.2,0.8 L1.2,-0.8 M-1.2,-0.8 L-1.2,0.8 M1.2,0.8 L1.2,-0.8 z" fill="none" stroke="currentColor" strokeWidth="0.5" strokeLinejoin="round" />
                    </svg>
                    <span className="font-medium">محبس (VALVE)</span>
                  </div>
                  <div className="px-3 sm:px-4 py-3 lg:border-r border-slate-200 cursor-default flex items-center gap-2">
                    <svg viewBox="-2 -2 4 4" className="w-4 h-4 text-[#d97706]">
                      <circle cx="0" cy="0" r="1.5" fill="none" stroke="currentColor" strokeWidth="0.4" />
                      <path d="M-0.8,-0.6 L0.8,0 L-0.8,0.6 Z" fill="none" stroke="currentColor" strokeWidth="0.4" />
                    </svg>
                    <span className="font-medium">
                      مضخة {designValues.pump?.type ? `(${designValues.pump.type})` : ''} {designValues.pump?.pressureBar ? ` ${designValues.pump.pressureBar} BAR` : ''}
                    </span>
                  </div>
                  <div className="px-3 sm:px-4 py-3 lg:border-r border-slate-200 cursor-default flex items-center gap-2">
                    <div className="w-3 h-3 bg-[#0ea5e9] bg-opacity-10 border border-[1px] border-[#bae6fd] border-dashed rounded-sm"></div>
                    <span className="font-medium">قطاع (ZONE)</span>
                  </div>
                </div>
                
                <div className="flex bg-emerald-50 text-emerald-700 border-l border-emerald-100 font-bold px-6 py-3 rounded-br-lg">
                  AREA: {designValues.length * designValues.width} m²
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Load Design Modal */}
      <AnimatePresence>
        {showLoadModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowLoadModal(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-lg rounded-[2.5rem] shadow-2xl overflow-hidden"
            >
              <div className="p-8 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <h3 className="text-lg font-black text-slate-800">التصميمات المحفوظة</h3>
                <button onClick={() => setShowLoadModal(false)} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="p-4 max-h-[60vh] overflow-y-auto">
                {isLoadingList ? (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                    <Loader2 className="w-8 h-8 animate-spin mb-4" />
                    <span className="text-sm font-bold">جاري تحميل القائمة...</span>
                  </div>
                ) : savedDesigns.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-400">
                    <div className="w-16 h-16 bg-slate-100 rounded-3xl flex items-center justify-center mb-6">
                      <FolderOpen className="w-8 h-8 text-slate-300" />
                    </div>
                    <span className="text-sm font-bold italic">لا توجد تصميمات محفوظة حالياً</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 pb-20">
                    {savedDesigns.map((design: any) => {
                      const isSelected = !!compareSelection.find(d => d.id === design.id);
                      return (
                        <div 
                          key={design.id}
                          onClick={() => handleLoadDesign(design)}
                          className={`group flex items-center justify-between p-5 hover:bg-emerald-50 border hover:border-emerald-200 rounded-2xl cursor-pointer transition-all ${
                            isSelected ? 'bg-emerald-50 border-emerald-500 shadow-md shadow-emerald-100' : 'bg-slate-50 border-slate-100'
                          }`}
                        >
                          <div className="flex items-center gap-4">
                            <label className="relative flex items-center justify-center p-2 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                              <input 
                                type="checkbox" 
                                checked={isSelected}
                                onChange={(e) => toggleCompare(design, e as any)}
                                className="w-5 h-5 accent-emerald-600 rounded bg-white border-slate-300"
                              />
                            </label>
                            <div className={`w-10 h-10 bg-white rounded-xl flex items-center justify-center shadow-sm transition-colors ${
                              isSelected ? 'bg-emerald-600 text-white' : 'text-slate-400 group-hover:bg-emerald-600 group-hover:text-white'
                            }`}>
                              <Activity className="w-5 h-5" />
                            </div>
                            <div className="flex flex-col">
                              <span className="text-sm font-black text-slate-800">{design.name}</span>
                              <span className="text-[10px] text-slate-400 font-bold uppercase">
                                {design.updatedAt?.seconds ? new Date(design.updatedAt.seconds * 1000).toLocaleDateString('ar-EG') : 'جاري الحفظ...'}
                              </span>
                            </div>
                          </div>
                          <button 
                            onClick={(e) => handleDeleteDesign(design.id, e)}
                            className="p-2 text-slate-300 hover:text-red-500 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Compare Action Bar inside Load Modal */}
              <AnimatePresence>
                {compareSelection.length >= 2 && (
                  <motion.div 
                    initial={{ y: 50, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 50, opacity: 0 }}
                    className="absolute bottom-0 left-0 right-0 p-5 bg-white border-t border-slate-200 shadow-[0_-10px_30px_rgba(0,0,0,0.05)] flex justify-between items-center z-10"
                  >
                    <div className="flex items-center gap-3">
                      <div className="bg-emerald-100 text-emerald-700 w-8 h-8 rounded-full flex items-center justify-center font-black">
                        {compareSelection.length}
                      </div>
                      <span className="text-sm font-bold text-slate-600">تم تحديدها للمقارنة</span>
                    </div>
                    <button 
                      onClick={() => { setShowCompareModal(true); setShowLoadModal(false); }}
                      className="flex items-center gap-2 bg-emerald-600 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-emerald-700 transition shadow-lg shadow-emerald-500/20"
                    >
                      <Scale className="w-5 h-5" />
                      مقارنة
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Export Options Modal */}
      <AnimatePresence>
        {showExportModal && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" 
              onClick={() => setShowExportModal(false)} 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex justify-between items-center shrink-0 bg-slate-50/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
                    <Download className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-slate-800">خيارات التصدير (PDF)</h2>
                    <p className="text-[10px] font-bold text-slate-400 mt-1">اختر الأقسام التي تود تضمينها في التقرير</p>
                  </div>
                </div>
                <button onClick={() => setShowExportModal(false)} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="p-6 flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
                <label className="flex items-center gap-3 p-3 bg-slate-100/50 hover:bg-slate-100 rounded-xl cursor-pointer transition-colors mb-2">
                  <input 
                    type="checkbox"
                    checked={exportSelection.length === EXPORT_SECTIONS.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setExportSelection(EXPORT_SECTIONS.map(s => s.id));
                      } else {
                        setExportSelection([]);
                      }
                    }}
                    className="w-5 h-5 accent-blue-600 rounded border-slate-300"
                  />
                  <span className="text-sm font-black text-slate-700">تحديد الكل</span>
                </label>
                
                {EXPORT_SECTIONS.map(section => (
                  <label key={section.id} className="flex items-center gap-3 p-2 cursor-pointer group">
                    <input 
                      type="checkbox"
                      checked={exportSelection.includes(section.id)}
                      onChange={(e) => {
                        if (e.target.checked) setExportSelection(prev => [...prev, section.id]);
                        else setExportSelection(prev => prev.filter(id => id !== section.id));
                      }}
                      className="w-4 h-4 accent-blue-600 rounded border-slate-300"
                    />
                    <span className="text-sm font-bold text-slate-600 group-hover:text-blue-600 transition-colors">{section.name}</span>
                  </label>
                ))}
              </div>

              <div className="p-6 bg-slate-50 border-t border-slate-100 flex gap-3">
                <button 
                  disabled={exportSelection.length === 0 || isExporting}
                  onClick={() => handleExportPDF(false)}
                  className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-black text-white transition-all shadow-lg ${
                    exportSelection.length === 0 ? 'bg-slate-300 shadow-none cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/20'
                  }`}
                >
                  {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  تحميل المحدد ({exportSelection.length})
                </button>
                <button 
                  disabled={isExporting}
                  onClick={() => handleExportPDF(true)}
                  className="px-4 py-3 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-xl text-xs font-black transition-all"
                >
                  تحميل الكل
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Compare Modal */}
      <AnimatePresence>
        {showCompareModal && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" 
              onClick={() => setShowCompareModal(false)} 
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative bg-white w-full max-w-6xl max-h-[90vh] rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden"
            >
              {/* Header */}
              <div className="p-6 border-b border-slate-100 flex justify-between items-center shrink-0 bg-slate-50/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
                    <Scale className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-slate-800">مقارنة التصميمات</h2>
                    <p className="text-[10px] font-bold text-slate-400 mt-1">المقارنة بين {compareSelection.length} تصميمات مختلفة</p>
                  </div>
                </div>
                <button onClick={() => setShowCompareModal(false)} className="p-2 hover:bg-slate-100 rounded-full text-slate-400">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              {/* Body: Grid */}
              <div className="flex-1 overflow-y-auto p-8 bg-slate-50">
                <div className={`grid gap-6 ${compareSelection.length === 2 ? 'grid-cols-2 lg:mx-20' : 'grid-cols-1 md:grid-cols-3'}`}>
                  {compareSelection.map(design => {
                    const data = design.analysis;
                    const ovs = design.overrides || {};
                    const finalDesign = { ...data.design, ...ovs };
                    
                    return (
                      <div key={design.id} className="bg-white rounded-3xl p-6 shadow-sm border border-slate-200 flex flex-col gap-8 transition-all hover:shadow-md">
                        <div className="border-b border-slate-100 pb-4">
                          <h3 className="text-lg font-black text-slate-800">{design.name}</h3>
                          <span className="text-xs text-slate-400 uppercase font-medium">{new Date(design.updatedAt?.seconds * 1000).toLocaleDateString('ar-EG')}</span>
                        </div>
                        
                        {/* Summary */}
                        <div>
                          <p className="text-xs text-slate-600 leading-relaxed font-medium bg-slate-50 p-3 rounded-xl border border-slate-100 line-clamp-3" title={data.summary}>
                            {data.summary || 'بدون ملخص'}
                          </p>
                        </div>

                        {/* Plant & Root Zone */}
                        <div className="space-y-4">
                          <h4 className="text-sm font-black text-emerald-600 flex items-center gap-2">
                             <Sprout className="w-4 h-4" /> المحصول والتربة
                          </h4>
                          <div className="space-y-2 bg-emerald-50/50 p-4 rounded-2xl border border-emerald-100">
                            <div className="flex justify-between items-center text-xs">
                              <span className="text-slate-500 font-bold">المحصول</span>
                              <span className="font-black text-emerald-700">{data.charts.rootZone.cropName || 'غير محدد'}</span>
                            </div>
                            <div className="flex justify-between items-center text-xs">
                              <span className="text-slate-500 font-bold">العمق الفعال</span>
                              <span className="font-black text-emerald-700">{ovs.rootDepth ? Math.round(ovs.rootDepth * 0.7) : data.charts.rootZone.activeDepth} سم</span>
                            </div>
                          </div>
                        </div>

                        {/* Layout Details */}
                        <div className="space-y-4">
                          <h4 className="text-sm font-black text-blue-600 flex items-center gap-2">
                             <LayoutDashboard className="w-4 h-4" /> المخطط والأبعاد
                          </h4>
                          <div className="space-y-2 bg-blue-50/50 p-4 rounded-2xl border border-blue-100">
                            <div className="flex justify-between items-center text-xs">
                              <span className="text-slate-500 font-bold">المساحة</span>
                              <span className="font-black text-blue-700">{finalDesign.length * finalDesign.width} م²</span>
                            </div>
                            <div className="flex justify-between items-center text-xs">
                              <span className="text-slate-500 font-bold">الأبعاد</span>
                              <span className="font-black text-blue-700">{finalDesign.length}م × {finalDesign.width}م</span>
                            </div>
                            <div className="flex justify-between items-center text-xs mt-2 pt-2 border-t border-blue-100">
                              <span className="text-slate-500 font-bold">الرئيسي</span>
                              <span className="font-bold font-mono text-blue-700">{finalDesign.mainLine}</span>
                            </div>
                            <div className="flex justify-between items-center text-xs">
                              <span className="text-slate-500 font-bold">الفرعي / الخراطيم</span>
                              <span className="font-bold font-mono text-blue-700">{finalDesign.subMainLine} / {finalDesign.laterals}</span>
                            </div>
                          </div>
                        </div>

                        {/* Water Demand & Efficiency */}
                        <div className="space-y-4">
                          <h4 className="text-sm font-black text-amber-600 flex items-center gap-2">
                             <Droplet className="w-4 h-4" /> الكفاءة والمياه (يومياً)
                          </h4>
                          <div className="space-y-3 bg-amber-50/50 p-4 rounded-2xl border border-amber-100">
                            <div>
                               <div className="flex justify-between items-center text-xs mb-1">
                                 <span className="text-slate-500 font-bold">كفاءة الرشاشات</span>
                                 <span className="font-black text-emerald-600">{finalDesign.sprinklerEfficiency}%</span>
                               </div>
                               <div className="w-full h-1.5 bg-amber-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${finalDesign.sprinklerEfficiency}%` }}></div>
                               </div>
                            </div>
                            
                            <div className="flex justify-between items-center text-[10px] mt-2 border-t border-amber-100/50 pt-2">
                              <span className="text-slate-500 font-bold">صافي الاحتياج</span>
                              <span className="font-bold text-amber-700">{data.charts.waterBalance.netRequirement} لتر</span>
                            </div>
                            <div className="flex justify-between items-center text-[10px]">
                              <span className="text-slate-500 font-bold">أمطار</span>
                              <span className="font-bold text-blue-600">-{data.charts.waterBalance.rainfallEffective} لتر</span>
                            </div>
                            <div className="flex justify-between items-center text-[10px]">
                              <span className="text-slate-500 font-bold">فاقد الكفاءة</span>
                              <span className="font-bold text-red-500">+{data.charts.waterBalance.efficiencyLoss} لتر</span>
                            </div>
                            
                            <div className="flex justify-between items-center text-sm mt-2 border-t border-amber-100 pt-2">
                              <span className="text-amber-800 font-black">إجمالي الضخ</span>
                              <span className="font-black text-amber-600">{data.charts.waterBalance.totalGross} لتر</span>
                            </div>
                          </div>
                        </div>

                      </div>
                    )
                  })}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
