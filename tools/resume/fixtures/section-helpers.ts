// Two small builders shared by the resume tests (prompt EK, October 28, 2026): an empty page extraction and a boundary section. Generic, no document text.
export const emptyEx = (o: any) => ({ candidate_location: "", candidate_phone: "", candidate_email: "", printed_header: "", work_history: [], education: [], certifications: [], skills: [], skills_heading: "", skills_position: null, freeform: [], ...o });
export const sec = (heading: string, category: string, cont = false) => ({ heading, category, is_continuation_of_previous_page: cont });
