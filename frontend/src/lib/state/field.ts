import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Field {
  id: string;
  farm_id: string;
  user_id: string;
  name: string;
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
  centroid: {
    type: 'Point';
    coordinates: [number, number];
  };
  area_hectares: number;
  status: 'active' | 'inactive' | 'archived';
  created_at: string;
  updated_at: string;
}

interface FieldState {
  currentField: Field | null;
  fields: Field[];
  setCurrentField: (field: Field | null) => void;
  setFields: (fields: Field[]) => void;
  addField: (field: Field) => void;
  updateField: (id: string, updates: Partial<Field>) => void;
  removeField: (id: string) => void;
  clearFieldContext: () => void;
}

export const useFieldStore = create<FieldState>()(
  persist(
    (set) => ({
      currentField: null,
      fields: [],
      
      setCurrentField: (field) => set({ currentField: field }),
      
      setFields: (fields) => set({ fields }),
      
      addField: (field) => set((state) => ({
        fields: [...state.fields, field],
      })),
      
      updateField: (id, updates) => set((state) => ({
        fields: state.fields.map((f) =>
          f.id === id ? { ...f, ...updates } : f
        ),
        currentField: state.currentField?.id === id
          ? { ...state.currentField, ...updates }
          : state.currentField,
      })),
      
      removeField: (id) => set((state) => ({
        fields: state.fields.filter((f) => f.id !== id),
        currentField: state.currentField?.id === id ? null : state.currentField,
      })),
      
      clearFieldContext: () => set({
        currentField: null,
      }),
    }),
    {
      name: 'agrifur2-fields',
      partialize: (state) => ({
        currentField: state.currentField,
        fields: state.fields,
      }),
    }
  )
);
