import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  orderBy,
  writeBatch
} from 'firebase/firestore';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User,
  signOut
} from 'firebase/auth';
// @ts-ignore
import { ReactSortable, ItemInterface } from 'react-sortablejs';
import Flatpickr from 'react-flatpickr';
import { Portuguese } from 'flatpickr/dist/l10n/pt';
import 'flatpickr/dist/themes/dark.css';
import { db, auth } from './firebase';
import { LogIn, LogOut, Plus, Trash2, Calendar, LayoutDashboard } from 'lucide-react';

// --- Types ---
interface Task extends ItemInterface {
  id: string;
  title: string;
  desc?: string;
  date?: string;
  priorityBase: 'Normal' | 'Urgente' | 'Imediato';
  columnId: number;
  order: number;
  userId: string;
}

interface Column {
  id: number;
  title: string;
  icon: string;
}

const COLUMNS: Column[] = [
  { id: 0, title: "A FAZER", icon: "fa-clipboard" },
  { id: 1, title: "EM PROGRESSO", icon: "fa-bolt" },
  { id: 2, title: "REVISÃO", icon: "fa-magnifying-glass" },
  { id: 3, title: "CONCLUÍDO", icon: "fa-check" }
];

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // We don't throw here to avoid crashing the whole app, but we log it.
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Partial<Task> | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const scrollToColumn = (columnId: number) => {
    setTimeout(() => {
      const board = boardRef.current;
      const destCol = board?.querySelector(`.col-${columnId}`) as HTMLElement;
      if (board && destCol) {
        board.scrollTo({
          left: destCol.offsetLeft - (board.clientWidth / 2) + (destCol.clientWidth / 2),
          behavior: 'smooth'
        });
      }
    }, 100);
  };

  const [isDragging, setIsDragging] = useState(false);
  const dragPos = useRef({ x: 0, y: 0 });
  const lastTargetCol = useRef<number | null>(null);
  const canScroll = useRef(true);

  useEffect(() => {
    const handleMove = (e: any) => {
      if (!isDragging || !boardRef.current) return;
      
      const clientX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
      const clientY = e.clientY || (e.touches ? e.touches[0].clientY : 0);
      dragPos.current = { x: clientX, y: clientY };

      const board = boardRef.current;
      const edgeSize = window.innerWidth * 0.15;
      
      // If finger is in the edge zone
      const isAtLeftEdge = clientX < edgeSize && clientX > 0;
      const isAtRightEdge = clientX > window.innerWidth - edgeSize;

      if (isAtLeftEdge || isAtRightEdge) {
        if (canScroll.current) {
          canScroll.current = false;
          
          // Determine current column index based on scroll position
          const colWidth = board.querySelector('.column')?.clientWidth || 320;
          const gap = 24;
          const currentScroll = board.scrollLeft;
          const currentIndex = Math.round(currentScroll / (colWidth + gap));
          
          let targetIndex = currentIndex;
          if (isAtLeftEdge) targetIndex = Math.max(0, currentIndex - 1);
          if (isAtRightEdge) targetIndex = Math.min(COLUMNS.length - 1, currentIndex + 1);
          
          if (targetIndex !== currentIndex) {
            scrollToColumn(targetIndex);
          }

          // Cooldown to prevent runaway scrolling
          setTimeout(() => {
            canScroll.current = true;
          }, 800); 
        }
      } else {
        // Reset scroll ability when moving away from edges
        canScroll.current = true;
      }
    };

    if (isDragging) {
      window.addEventListener('pointermove', handleMove);
      window.addEventListener('touchmove', handleMove, { passive: false });
    } else {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('touchmove', handleMove);
      canScroll.current = true;
    }

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('touchmove', handleMove);
    };
  }, [isDragging]);

  // --- Auth ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const login = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login error:", error);
    }
  };

  const logout = () => signOut(auth);

  // --- Firestore Sync ---
  useEffect(() => {
    if (!user) {
      setTasks([]);
      return;
    }

    const q = query(
      collection(db, 'tasks'),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const t: Task[] = [];
      snapshot.forEach((doc) => {
        t.push({ id: doc.id, ...doc.data() } as Task);
      });
      setTasks(t);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tasks');
    });

    return () => unsubscribe();
  }, [user]);

  // --- Original Logic Functions ---
  const formatCardDate = (dateStr?: string) => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const dia = String(d.getDate()).padStart(2, '0');
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const hr = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dia}/${mes}, ${hr}:${min}`;
  };

  const calculateStatus = (card: Task, isDoneCol: boolean) => {
    if (isDoneCol) return { class: 'card-concluido border-normal', tagHtml: null };

    let finalPriority = card.priorityBase || "Normal";
    let tagClass = "tag-normal";
    let borderClass = "border-normal";
    let icon = "fa-bookmark";

    if (card.date) {
      const agora = new Date();
      const prazo = new Date(card.date);
      if (!isNaN(prazo.getTime())) {
        const diffMinutos = (prazo.getTime() - agora.getTime()) / (1000 * 60);
        if (diffMinutos < 0) {
          finalPriority = "Imediato";
        } else if (diffMinutos <= 60) {
          finalPriority = "Urgente";
        }
      }
    }

    if (finalPriority === "Urgente") {
      tagClass = "tag-urgente";
      borderClass = "border-urgente";
      icon = "fa-fire";
    } else if (finalPriority === "Imediato") {
      tagClass = "tag-imediato";
      borderClass = "border-imediato";
      icon = "fa-triangle-exclamation";
    }

    return { 
      class: borderClass, 
      tagHtml: (
        <div className={`tag ${tagClass}`}>
          <i className={`fa-solid ${icon}`}></i> {finalPriority}
        </div>
      )
    };
  };

  // --- Task Actions ---
  const openModal = (columnId: number = 0, task?: Task) => {
    if (task) {
      setEditingTask(task);
    } else {
      setEditingTask({
        columnId,
        title: '',
        desc: '',
        priorityBase: 'Normal',
        date: ''
      });
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingTask(null);
  };

  const saveTask = async () => {
    if (!user || !editingTask || !editingTask.title?.trim()) return;

    const taskData = {
      ...editingTask,
      title: editingTask.title.toUpperCase(),
      userId: user.uid,
      order: editingTask.order ?? tasks.filter(t => t.columnId === editingTask.columnId).length
    };

    try {
      if (editingTask.id) {
        const { id, ...rest } = taskData;
        await updateDoc(doc(db, 'tasks', id), rest);
      } else {
        await addDoc(collection(db, 'tasks'), taskData);
      }
      closeModal();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'tasks');
    }
  };

  const delCard = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    if (window.confirm("Tem certeza que deseja apagar esta nota permanentemente?")) {
      try {
        await deleteDoc(doc(db, 'tasks', taskId));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `tasks/${taskId}`);
      }
    }
  };

  const onSortEnd = async (columnId: number, newTasks: Task[]) => {
    if (!user) return;

    const batch = writeBatch(db);
    newTasks.forEach((task, index) => {
      const taskRef = doc(db, 'tasks', task.id);
      batch.update(taskRef, { 
        columnId: columnId,
        order: index 
      });
    });

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'tasks (batch)');
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0b0f17]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-cyan-400"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[#0b0f17] p-6 text-center">
        <div className="bg-indigo-500/20 p-6 rounded-2xl border border-indigo-500/30 mb-8">
          <LayoutDashboard className="w-16 h-16 text-indigo-400" />
        </div>
        <h1 className="font-black text-white tracking-widest text-3xl uppercase mb-2">ATI-FER <span className="text-slate-500 font-normal">(KanBan)</span></h1>
        <p className="text-sm text-slate-500 font-bold uppercase tracking-widest mb-12">Gerenciador de Tarefas Profissional</p>
        <button 
          onClick={login}
          className="flex items-center gap-3 bg-cyan-500 hover:bg-cyan-400 text-[#083344] font-black py-4 px-8 rounded-xl transition-all transform hover:scale-105 uppercase tracking-widest text-sm"
        >
          <LogIn className="w-5 h-5" />
          Entrar com Google
        </button>
      </div>
    );
  }

  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.columnId === 3).length;

  return (
    <div className={`flex flex-col h-screen overflow-hidden ${isDragging ? 'is-dragging' : ''}`}>
      <header className="p-4 border-b border-white/5 bg-[#0b0f17]">
        <div className="flex justify-between items-start md:items-center gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="bg-indigo-500/20 p-2 rounded-lg border border-indigo-500/30 flex-shrink-0 mt-1 md:mt-0">
              <LayoutDashboard className="w-5 h-5 text-indigo-400" />
            </div>
            <div className="flex flex-col min-w-0">
              <h1 className="font-black text-white tracking-widest text-sm md:text-lg uppercase whitespace-nowrap">
                ATI-FER <span className="text-slate-500 font-normal">(KanBan)</span>
              </h1>
              <p className="text-[8px] md:text-[10px] text-slate-500 font-bold uppercase tracking-widest whitespace-nowrap">
                Gerenciador de Tarefas
              </p>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-[8px] md:text-[10px] font-bold text-slate-500 uppercase tracking-widest">Progresso:</span>
                <span className="text-cyan-400 font-black text-[10px] md:text-sm">{completedTasks}/{totalTasks}</span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => openModal(0)} className="header-btn btn-cyan flex items-center gap-1 bg-cyan-500 text-[#083344] px-2 py-1.5 rounded-lg font-bold text-[10px] md:text-xs uppercase tracking-wider hover:bg-cyan-400 transition whitespace-nowrap">
              <Plus className="w-3 h-3 md:w-4 h-4" /> Nova Tarefa
            </button>
            <button onClick={logout} className="p-1.5 text-slate-500 hover:text-white transition">
              <LogOut className="w-4 h-4 md:w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="board" id="main-board" ref={boardRef}>
        {COLUMNS.map((col) => (
          <div key={col.id} className={`column col-${col.id}`}>
            <div className="col-header">
              <span className="col-title">
                <i className={`fa-solid ${col.icon}`}></i> {col.title}
              </span>
              <div className="flex gap-2 items-center">
                <span className="col-count">{tasks.filter(t => t.columnId === col.id).length}</span>
                <button 
                  onClick={() => openModal(col.id)} 
                  className="col-count hover:bg-white/10 transition cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>
            
            <ReactSortable
              id={`col-list-${col.id}`}
              list={tasks.filter(t => t.columnId === col.id)}
              setList={(newList) => onSortEnd(col.id, newList as Task[])}
              onMove={(evt: any) => {
                const toId = evt.to.id;
                const colId = toId.replace('col-list-', '');
                const targetId = parseInt(colId);
                
                // Visual feedback for the drop zone
                document.querySelectorAll('.card-list').forEach(el => el.classList.remove('drag-active'));
                evt.to.classList.add('drag-active');

                if (colId !== "" && targetId !== col.id && targetId !== lastTargetCol.current) {
                  lastTargetCol.current = targetId;
                  const board = boardRef.current;
                  const destCol = board?.querySelector(`.col-${colId}`) as HTMLElement;
                  if (board && destCol) {
                    board.scrollTo({
                      left: destCol.offsetLeft - (board.clientWidth / 2) + (destCol.clientWidth / 2),
                      behavior: 'smooth'
                    });
                  }
                }
                return true;
              }}
              onStart={(evt: any) => {
                setIsDragging(true);
                lastTargetCol.current = col.id;
                const e = evt.originalEvent;
                if (e) {
                  dragPos.current = { 
                    x: e.clientX || (e.touches ? e.touches[0].clientX : 0),
                    y: e.clientY || (e.touches ? e.touches[0].clientY : 0)
                  };
                }
              }}
              onChoose={() => setIsDragging(true)}
              onUnchoose={() => {
                setIsDragging(false);
                lastTargetCol.current = null;
                document.querySelectorAll('.card-list').forEach(el => el.classList.remove('drag-active'));
              }}
              onEnd={(e: any) => {
                setIsDragging(false);
                lastTargetCol.current = null;
                document.querySelectorAll('.card-list').forEach(el => el.classList.remove('drag-active'));
                const toId = e.to.id;
                const colId = toId.replace('col-list-', '');
                if (colId !== "") {
                  scrollToColumn(parseInt(colId));
                }
              }}
              group="tasks"
              animation={150}
              delay={200}
              delayOnTouchOnly={true}
              touchStartThreshold={5}
              swapThreshold={0.5}
              invertSwap={true}
              direction="vertical"
              className="card-list"
              ghostClass="card-ghost"
              chosenClass="card-chosen"
              dragClass="card-dragging"
              forceFallback={true}
              fallbackClass="card-fallback"
              fallbackOnBody={true}
              fallbackTolerance={3}
              scroll={false} // We handle scrolling manually for better control
            >
              {tasks.filter(t => t.columnId === col.id).map((task) => {
                const status = calculateStatus(task, col.id === 3);
                const dateText = formatCardDate(task.date);
                return (
                  <div 
                    key={task.id} 
                    className={`card ${status.class}`}
                    onDoubleClick={() => openModal(col.id, task)}
                  >
                    <button 
                      onClick={(e) => delCard(e, task.id)} 
                      className="btn-trash"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <div>
                      <h3 className="card-title">{task.title}</h3>
                      {task.desc && <p className="card-desc">{task.desc}</p>}
                      {task.date && dateText && (
                        <div className="card-date">
                          <Calendar className="w-3 h-3 text-slate-500" /> 
                          Entregar às <span className="text-white font-bold ml-1">{dateText}</span>
                        </div>
                      )}
                      {status.tagHtml}
                    </div>
                  </div>
                );
              })}
            </ReactSortable>
          </div>
        ))}
      </div>

      {isModalOpen && editingTask && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">DADOS DA NOTA</h2>
            
            <div className="input-group">
              <label className="label">Título da Atividade</label>
              <input 
                type="text" 
                className="input-field uppercase" 
                placeholder="EX.: NOME DA ATIVIDADE"
                value={editingTask.title}
                onChange={e => setEditingTask({...editingTask, title: e.target.value})}
              />
            </div>

            <div className="input-group">
              <label className="label">Descrição Detalhada</label>
              <textarea 
                className="input-field h-24" 
                placeholder="Detalhes da tarefa..."
                value={editingTask.desc}
                onChange={e => setEditingTask({...editingTask, desc: e.target.value})}
              />
            </div>

            <div className="input-group">
              <label className="label">Data e Hora de Entrega</label>
              <Flatpickr
                className="input-field cursor-pointer"
                placeholder="Toque para selecionar a data e hora..."
                value={editingTask.date}
                onChange={([date]) => setEditingTask({...editingTask, date: date.toISOString()})}
                options={{
                  enableTime: true,
                  dateFormat: "Y-m-d\\TH:i",
                  altInput: true,
                  altFormat: "d/m/Y, H:i",
                  locale: Portuguese,
                  time_24hr: true,
                }}
              />
            </div>

            <div className="input-group">
              <label className="label">Prioridade Base</label>
              <select 
                className="input-field"
                value={editingTask.priorityBase}
                onChange={e => setEditingTask({...editingTask, priorityBase: e.target.value as any})}
              >
                <option value="Normal">Normal</option>
                <option value="Urgente">Urgente</option>
                <option value="Imediato">Imediato</option>
              </select>
            </div>

            <div className="flex gap-3 mt-6">
              <button 
                onClick={closeModal} 
                className="flex-1 font-bold text-slate-500 hover:text-white transition text-xs uppercase tracking-wider py-3"
              >
                Cancelar
              </button>
              <button 
                onClick={saveTask} 
                className="flex-1 bg-cyan-500 text-[#083344] font-black py-3 px-6 rounded-lg uppercase tracking-widest text-xs hover:bg-cyan-400 transition"
              >
                Salvar Nota
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
